#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基于命令行的 GPS 串口到 MQTT 发布器。

去除原有的 tkinter 可视化界面，改为在树莓派等无图形环境下运行。
在文件顶部集中配置串口、MQTT、设备与历史文件等参数，便于修改。
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import socket
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

import paho.mqtt.client as mqtt
import serial
import serial.tools.list_ports


# ====================== 可修改的参数 ======================
# 串口配置
SERIAL_PORT: str | None = None  # 示例："/dev/ttyAMA0"，为 None 时自动选择第一个可用串口
SERIAL_BAUDRATE: int = 9600

# MQTT 配置
MQTT_HOST: str = "wauclub.com"
MQTT_PORT: int = 1883
MQTT_USERNAME: str = "device"
MQTT_PASSWORD: str = "123456"
MQTT_TOPIC: str = "student/location"
MQTT_CONTROL_TOPIC: str = "student/location/control"
MQTT_STATUS_TOPIC: str = "student/location/status"
MQTT_COMMAND_RESULT_TOPIC: str = "student/location/control/result"

# 设备 ID
DEVICE_ID: str = "um220_tracker_001"

# 历史文件（JSON Lines）
HISTORY_FILE: Path = Path(__file__).with_name("history.jsonl")

# 手动发布默认值（用于 --manual-* 参数缺省时）
DEFAULT_MANUAL_LONGITUDE: float = 121.061722
DEFAULT_MANUAL_LATITUDE: float = 40.885880
DEFAULT_MANUAL_SPEED_MS: float = 0.0
# ========================================================


logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)


@dataclass
class PublisherConfig:
    """运行所需的全部配置。"""

    port: str
    baudrate: int
    mqtt_host: str
    mqtt_port: int
    mqtt_user: str
    mqtt_pass: str
    mqtt_topic: str
    mqtt_control_topic: str
    mqtt_status_topic: str
    mqtt_command_result_topic: str
    device_id: str
    history_file: Path


class GPSPublisher:
    """负责读取串口、解析 NMEA 并发布到 MQTT 的核心类。"""

    def __init__(self, config: PublisherConfig):
        self.config = config
        self.service_active = False
        self.gps_streaming = False
        self.ser: Optional[serial.Serial] = None
        self.mqtt_client: Optional[mqtt.Client] = None
        self.history_file = config.history_file
        self.history_file.touch(exist_ok=True)
        self._mqtt_connected = False
        self._data_count = 0
        self._last_start_error: Optional[str] = None
        self.command_help = {
            "start": "启动或恢复 GPS 采集",
            "stop": "停止 GPS 采集",
            "status": "返回设备状态",
            "help": "列出支持的命令及作用",
        }

    # ------------------------ 公共接口 ------------------------
    def run(self):
        """阻塞式运行，支持 MQTT 控制启动/停止与状态查询。"""

        if self.service_active:
            logging.warning("GPS 服务已在运行中")
            return

        self.service_active = True
        try:
            self._initialize_mqtt()
            self.start_streaming()

            while self.service_active:
                try:
                    if self.gps_streaming and self.ser:
                        line_bytes = self.ser.readline()
                        if not line_bytes:
                            continue

                        line = line_bytes.decode("utf-8", errors="ignore").strip()
                        if not line:
                            continue

                        logging.debug("收到原始 NMEA: %s", line)

                        gps_data = self.parse_nmea_sentence(line, self.config.device_id)
                        if not gps_data:
                            logging.debug("未解析的 NMEA 数据: %s", line)
                            continue

                        self.publish_gps_data(gps_data, self.config.mqtt_topic)
                        self._data_count += 1

                        if self._data_count % 10 == 0:
                            logging.info("运行中... 已发送 %d 条数据", self._data_count)

                except serial.SerialException as exc:
                    logging.error("串口错误: %s", exc)
                    self.stop_streaming()
                except Exception as exc:  # noqa: BLE001
                    logging.error("处理数据时出错: %s", exc)

                time.sleep(0.1)

        except KeyboardInterrupt:
            logging.info("收到中断信号，准备退出...")
        except Exception as exc:  # noqa: BLE001
            logging.error("GPS 发布器错误: %s", exc)
        finally:
            self.service_active = False
            self.cleanup_resources()

    def publish_manual_location(
        self,
        longitude: float,
        latitude: float,
        speed_ms: float,
        device_id: Optional[str] = None,
    ) -> None:
        """在无设备时手动发布一条测试数据。"""

        payload: Dict[str, Any] = {
            "message_type": "MANUAL",
            "device_id": device_id or self.config.device_id,
            "timestamp": datetime.utcnow().isoformat(),
            "latitude": latitude,
            "longitude": longitude,
            "speed_ms": speed_ms,
            "speed_knots": round(speed_ms / 0.51444, 3) if speed_ms else 0.0,
            "source": "manual_input",
        }

        try:
            beijing_time = datetime.utcnow() + timedelta(hours=8)
            payload["time"] = beijing_time.strftime("%Y/%m/%d %H:%M:%S")
        except Exception:  # noqa: BLE001
            payload["time"] = datetime.now().strftime("%Y/%m/%d %H:%M:%S")

        client = mqtt.Client()
        if self.config.mqtt_user and self.config.mqtt_pass:
            client.username_pw_set(self.config.mqtt_user, self.config.mqtt_pass)

        try:
            client.connect(self.config.mqtt_host, self.config.mqtt_port, 60)
            client.loop_start()
            result = client.publish(self.config.mqtt_topic, json.dumps(payload, ensure_ascii=False), qos=1)
            result.wait_for_publish()
            self.append_history_file(payload)
            logging.info(
                "手动发布数据成功: 纬度=%s, 经度=%s, 速度=%.3f m/s",
                latitude,
                longitude,
                speed_ms,
            )
        except Exception as exc:  # noqa: BLE001
            logging.error("手动发布数据失败: %s", exc)
        finally:
            with contextlib.suppress(Exception):
                client.loop_stop()
                client.disconnect()

    # ---------------------- 初始化流程 -----------------------
    def _initialize_serial(self):
        available_ports = [port.device for port in serial.tools.list_ports.comports()]
        port = self.config.port

        if port:
            if port not in available_ports:
                suggestion = "，可能是大小写问题？" if any(p.lower() == port.lower() for p in available_ports) else ""
                available = ", ".join(available_ports) or "无可用串口"
                raise RuntimeError(f"指定的串口不存在: {port}（可用: {available}）{suggestion}")
        else:
            port = self._auto_detect_port()
            logging.info("未指定串口，自动选择: %s", port)

        try:
            self.ser = serial.Serial(
                port=port,
                baudrate=self.config.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1,
            )
        except serial.SerialException as exc:  # noqa: BLE001
            available = ", ".join(available_ports) or "无可用串口"
            original = getattr(exc, "original_exception", None)
            errno = getattr(exc, "errno", None)
            detail = str(exc) or "未知错误"

            if original:
                errno = getattr(original, "errno", errno)
                if not detail:
                    detail = str(original)

            busy_hint = ""
            if (errno == 16) or ("Device or resource busy" in detail) or ("Errno 16" in detail):
                busy_hint = "，设备被其他程序占用（例如 minicom），请关闭占用后重试"
            elif (errno == 13) or ("Permission denied" in detail) or ("Errno 13" in detail):
                busy_hint = "，权限不足，请确认当前用户对串口有访问权限"

            raise RuntimeError(f"串口打开失败: {port}，错误: {detail}{busy_hint}（可用: {available}）") from exc

        if not self.ser.is_open:
            raise RuntimeError("无法打开串口")

        logging.info("串口连接成功: %s", port)

    def _initialize_mqtt(self):
        self.mqtt_client = mqtt.Client()

        if self.config.mqtt_user and self.config.mqtt_pass:
            self.mqtt_client.username_pw_set(self.config.mqtt_user, self.config.mqtt_pass)

        def _on_connect(client, userdata, flags, rc):
            self._mqtt_connected = rc == 0
            if rc == 0:
                logging.info("MQTT 连接成功")
                if self.config.mqtt_control_topic:
                    client.subscribe(self.config.mqtt_control_topic)
                    logging.info("已订阅控制主题: %s", self.config.mqtt_control_topic)
            else:
                logging.error("MQTT 连接失败，错误码: %s", rc)

        def _on_disconnect(client, userdata, rc):
            self._mqtt_connected = False
            logging.info("MQTT 连接断开")

        self.mqtt_client.on_connect = _on_connect
        self.mqtt_client.on_disconnect = _on_disconnect
        self.mqtt_client.on_message = self._on_control_message

        self.mqtt_client.connect(self.config.mqtt_host, self.config.mqtt_port, 60)
        self.mqtt_client.loop_start()
        logging.info("MQTT 连接中: %s:%s", self.config.mqtt_host, self.config.mqtt_port)

    def _auto_detect_port(self) -> str:
        ports = [port.device for port in serial.tools.list_ports.comports()]
        if not ports:
            raise RuntimeError("未检测到可用串口，请检查连接")
        return ports[0]

    # ---------------------- 核心功能 ------------------------
    def start_streaming(self):
        """开启串口读取并发送配置命令。"""

        if self.gps_streaming:
            logging.info("GPS 采集已在运行")
            return True

        self._data_count = 0
        try:
            self._last_start_error = None
            self._initialize_serial()
            self.send_gps_commands()
            self.gps_streaming = True
            self.publish_status()
            logging.info("GPS 采集已启动")
            return True
        except Exception as exc:  # noqa: BLE001
            logging.error("启动 GPS 采集失败: %s", exc)
            self.gps_streaming = False
            self._last_start_error = f"{exc.__class__.__name__}: {exc}" if str(exc) else exc.__class__.__name__
            return False

    def stop_streaming(self):
        """停止串口读取并关闭串口。"""

        if not self.gps_streaming:
            logging.info("GPS 采集已停止，无需重复停止")
            return True

        self.gps_streaming = False
        self._close_serial()
        self.publish_status()
        logging.info("GPS 采集已停止")
        return True

    def send_gps_commands(self):
        """向 GPS 模块发送配置命令。"""

        config_commands = [
            b"$CFGMSG,0,,0\r\n",  # 关闭所有消息
            b"$CFGMSG,0,4,1\r\n",  # 开启 RMC 消息（1Hz）
            b"$CFGMSG,0,1,1\r\n",  # 开启 GLL 消息（1Hz）
        ]

        for cmd in config_commands:
            try:
                if self.ser:
                    self.ser.write(cmd)
                logging.info("发送配置命令: %s", cmd.decode().strip())
                time.sleep(0.5)
            except Exception as exc:  # noqa: BLE001
                logging.error("发送命令失败: %s", exc)

    def parse_nmea_sentence(self, sentence: str, device_id: str) -> Optional[Dict[str, Any]]:
        """解析 NMEA 协议数据。"""

        try:
            sentence = sentence.strip()

            if not sentence.startswith("$") or "*" not in sentence:
                return None

            data_body, checksum = sentence[1:].split("*")
            parts = data_body.split(",")

            nmea_type = parts[0]
            message_id = nmea_type[-3:]

            if message_id == "RMC":
                return self.parse_rmc(parts, device_id)
            if message_id == "GLL":
                return self.parse_gll(parts, device_id)
            if message_id == "GGA":
                return self.parse_gga(parts, device_id)

            if nmea_type not in {"TXT", "GNTXT"}:
                logging.debug("忽略未处理的 NMEA 类型: %s", nmea_type)
            return None

        except Exception as exc:  # noqa: BLE001
            logging.error("NMEA 解析错误: %s", exc)
            return None

    def parse_rmc(self, parts: list[str], device_id: str) -> Optional[Dict[str, Any]]:
        if len(parts) < 12:
            return None

        try:
            status = parts[2]
            if status != "A":
                return None

            utc_time = parts[1]
            time_str = f"{utc_time[:2]}:{utc_time[2:4]}:{utc_time[4:6]}" if utc_time and len(utc_time) >= 6 else None

            utc_date = parts[9]
            date_str = f"20{utc_date[4:6]}-{utc_date[2:4]}-{utc_date[0:2]}" if utc_date and len(utc_date) == 6 else None

            latitude = self.dm_to_decimal(parts[3], parts[4]) if parts[3] else None
            longitude = self.dm_to_decimal(parts[5], parts[6], is_longitude=True) if parts[5] else None

            speed_knots = float(parts[7]) if parts[7] else 0.0
            course = float(parts[8]) if parts[8] else 0.0
            speed_ms = speed_knots * 0.51444

            return {
                "message_type": "RMC",
                "device_id": device_id,
                "timestamp": datetime.now().isoformat(),
                "utc_time": time_str,
                "utc_date": date_str,
                "latitude": latitude,
                "longitude": longitude,
                "speed_knots": speed_knots,
                "speed_ms": speed_ms,
                "course": course,
                "status": status,
                "mode": parts[12] if len(parts) > 12 else None,
            }

        except (ValueError, IndexError) as exc:
            logging.error("RMC 解析错误: %s", exc)
            return None

    def parse_gll(self, parts: list[str], device_id: str) -> Optional[Dict[str, Any]]:
        if len(parts) < 7:
            return None

        try:
            if parts[6] not in {"A", "D"}:
                return None

            latitude = self.dm_to_decimal(parts[1], parts[2]) if parts[1] else None
            longitude = self.dm_to_decimal(parts[3], parts[4], is_longitude=True) if parts[3] else None
            utc_time = parts[5]
            time_str = f"{utc_time[:2]}:{utc_time[2:4]}:{utc_time[4:6]}" if utc_time and len(utc_time) >= 6 else None

            return {
                "message_type": "GLL",
                "device_id": device_id,
                "timestamp": datetime.now().isoformat(),
                "utc_time": time_str,
                "latitude": latitude,
                "longitude": longitude,
                "status": parts[6],
            }

        except (ValueError, IndexError) as exc:
            logging.error("GLL 解析错误: %s", exc)
            return None

    def parse_gga(self, parts: list[str], device_id: str) -> Optional[Dict[str, Any]]:
        if len(parts) < 15:
            return None

        try:
            latitude = self.dm_to_decimal(parts[2], parts[3]) if parts[2] else None
            longitude = self.dm_to_decimal(parts[4], parts[5], is_longitude=True) if parts[4] else None

            utc_time = parts[1]
            time_str = f"{utc_time[:2]}:{utc_time[2:4]}:{utc_time[4:6]}" if utc_time and len(utc_time) >= 6 else None

            quality = int(parts[6]) if parts[6] else 0
            num_satellites = int(parts[7]) if parts[7] else 0
            hdop = float(parts[8]) if parts[8] else 0.0
            altitude = float(parts[9]) if parts[9] else 0.0

            return {
                "message_type": "GGA",
                "device_id": device_id,
                "timestamp": datetime.now().isoformat(),
                "utc_time": time_str,
                "latitude": latitude,
                "longitude": longitude,
                "quality": quality,
                "num_satellites": num_satellites,
                "hdop": hdop,
                "altitude": altitude,
            }

        except (ValueError, IndexError) as exc:
            logging.error("GGA 解析错误: %s", exc)
            return None

    def dm_to_decimal(self, value: str, direction: str, is_longitude: bool = False) -> float:
        try:
            if not value:
                return 0.0

            if "." not in value:
                raise ValueError(f"无效的坐标值: {value}")

            degrees_length = 3 if is_longitude else 2
            degrees = int(value[:degrees_length])
            minutes = float(value[degrees_length:])
            decimal = degrees + minutes / 60.0

            if direction in {"S", "W"}:
                decimal = -decimal

            return round(decimal, 6)

        except ValueError as exc:
            logging.error("坐标转换错误: %s", exc)
            return 0.0

    def append_history_file(self, payload: Dict[str, Any]):
        if not self.history_file:
            return

        try:
            longitude = payload.get("longitude") or payload.get("lng")
            latitude = payload.get("latitude") or payload.get("lat")
            if longitude is None or latitude is None:
                return

            longitude = round(float(longitude), 6)
            latitude = round(float(latitude), 6)

            timestamp_value = (
                payload.get("time")
                or payload.get("timestamp")
                or datetime.now().strftime("%Y/%m/%d %H:%M:%S")
            )
            if isinstance(timestamp_value, (int, float)):
                dt = datetime.fromtimestamp(timestamp_value / 1000.0) if timestamp_value > 1e12 else datetime.fromtimestamp(
                    timestamp_value
                )
                timestamp_str = dt.strftime("%Y/%m/%d %H:%M:%S")
            else:
                timestamp_str = str(timestamp_value)

            speed_value = payload.get("speed_ms") or payload.get("speed") or payload.get("speed_knots")
            try:
                speed_value = float(speed_value)
            except (TypeError, ValueError):
                speed_value = 0.0

            record = {
                "timestamp": timestamp_str,
                "lng": longitude,
                "lat": latitude,
                "isInsideFence": bool(
                    payload.get("isInsideFence") or payload.get("inside_fence") or payload.get("insideFence") or False
                ),
                "speed": speed_value,
                "deviceId": payload.get("device_id") or payload.get("deviceId"),
                "raw": payload,
            }

            with self.history_file.open("a", encoding="utf-8") as file:
                file.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001
            logging.error("写入历史轨迹文件失败: %s", exc)

    def publish_gps_data(self, gps_data: Dict[str, Any], topic: str):
        if not self.mqtt_client or not gps_data:
            return

        try:
            try:
                beijing_time = datetime.utcnow() + timedelta(hours=8)
                gps_data["time"] = beijing_time.strftime("%Y/%m/%d %H:%M:%S")
            except Exception:  # noqa: BLE001
                gps_data["time"] = datetime.now().strftime("%Y/%m/%d %H:%M:%S")

            gps_data["source"] = "UM220-III"

            payload = json.dumps(gps_data, ensure_ascii=False)
            result = self.mqtt_client.publish(topic, payload)

            if result.rc == mqtt.MQTT_ERR_SUCCESS:
                logging.info(
                    "发布 %s 数据: 纬度=%s, 经度=%s",
                    gps_data.get("message_type"),
                    gps_data.get("latitude"),
                    gps_data.get("longitude"),
                )
                self.append_history_file(gps_data)
            else:
                logging.error("发布数据失败: %s", result.rc)

        except Exception as exc:  # noqa: BLE001
            logging.error("发布 GPS 数据异常: %s", exc)

    def publish_status(self):
        """将设备状态发布到状态主题。"""

        if not self.mqtt_client or not self.config.mqtt_status_topic:
            return

        status_payload = self._build_status_payload()

        try:
            self.mqtt_client.publish(self.config.mqtt_status_topic, json.dumps(status_payload, ensure_ascii=False))
            logging.info("已发布状态: %s", status_payload)
        except Exception as exc:  # noqa: BLE001
            logging.error("发布状态失败: %s", exc)

    def publish_command_result(self, command: str, success: bool, message: str, data: Optional[Dict[str, Any]] = None):
        """向命令结果主题发送执行结果，无论成功或失败。"""

        if not self.mqtt_client or not self.config.mqtt_command_result_topic:
            return

        payload: Dict[str, Any] = {
            "message_type": "COMMAND_RESULT",
            "device_id": self.config.device_id,
            "command": command,
            "success": success,
            "message": message,
            "timestamp": datetime.utcnow().isoformat(),
        }

        if data:
            payload.update(data)

        try:
            self.mqtt_client.publish(
                self.config.mqtt_command_result_topic,
                json.dumps(payload, ensure_ascii=False),
            )
            logging.info("已发布命令结果: %s", payload)
        except Exception as exc:  # noqa: BLE001
            logging.error("发布命令结果失败: %s", exc)

    def _build_status_payload(self) -> Dict[str, Any]:
        return {
            "message_type": "STATUS",
            "device_id": self.config.device_id,
            "running": self.gps_streaming,
            "serial_open": bool(self.ser and self.ser.is_open),
            "mqtt_connected": self._mqtt_connected,
            "sent_count": self._data_count,
            "timestamp": datetime.utcnow().isoformat(),
            "system_info": self._collect_system_info(),
        }

    def _collect_system_info(self) -> Dict[str, Any]:
        """收集设备基础信息（CPU、内存、IP 地址等）。"""

        info: Dict[str, Any] = {
            "cpu_cores": os.cpu_count(),
        }

        try:
            load1, load5, load15 = os.getloadavg()
            info["cpu_load"] = {"1m": round(load1, 2), "5m": round(load5, 2), "15m": round(load15, 2)}
        except OSError:
            pass

        memory_info = self._read_meminfo()
        if memory_info:
            info["memory"] = memory_info

        ip_address = self._get_local_ip()
        if ip_address:
            info["ip_address"] = ip_address

        return info

    def _read_meminfo(self) -> Dict[str, Any]:
        meminfo_path = Path("/proc/meminfo")
        if not meminfo_path.exists():
            return {}

        data: Dict[str, int] = {}
        try:
            for line in meminfo_path.read_text().splitlines():
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                parts = value.strip().split()
                if not parts:
                    continue
                # 数值单位以 kB 为主，这里转为 MB
                try:
                    kb_value = int(parts[0])
                    data[key] = kb_value
                except ValueError:
                    continue

            if not data:
                return {}

            total_kb = data.get("MemTotal", 0)
            available_kb = data.get("MemAvailable", 0)
            return {
                "total_mb": round(total_kb / 1024, 2),
                "available_mb": round(available_kb / 1024, 2),
            }
        except Exception:  # noqa: BLE001
            return {}

    def _get_local_ip(self) -> str:
        """尝试获取本地 IPv4 地址。"""

        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(("8.8.8.8", 80))
                return sock.getsockname()[0]
        except Exception:  # noqa: BLE001
            return ""

    def _on_control_message(self, client: mqtt.Client, userdata: Any, msg: mqtt.MQTTMessage):
        payload = msg.payload.decode("utf-8", errors="ignore").strip()
        command = payload.lower()

        try:
            data = json.loads(payload)
            command = str(data.get("command", command)).lower()
        except json.JSONDecodeError:
            pass

        success = False
        message = "未知的命令"
        extra_data: Dict[str, Any] | None = None

        if command in {"start", "resume"}:
            logging.info("收到 MQTT 控制命令: start")
            if self.gps_streaming:
                success = True
                message = "GPS 采集已在运行"
            else:
                success = self.start_streaming()
                if success:
                    message = "GPS 采集已启动"
                else:
                    detail = self._last_start_error or "请检查串口或权限"
                    message = f"启动失败: {detail}"
        elif command in {"stop", "pause"}:
            logging.info("收到 MQTT 控制命令: stop")
            success = self.stop_streaming()
            message = "GPS 采集已停止" if success else "停止操作未生效"
        elif command in {"status", "state"}:
            logging.info("收到 MQTT 控制命令: status")
            success = True
            extra_data = {"status": self._build_status_payload()}
            self.publish_status()
            message = "已返回设备状态"
        elif command == "help":
            logging.info("收到 MQTT 控制命令: help")
            success = True
            extra_data = {"commands": self.command_help}
            message = "命令列表已返回"
        else:
            logging.warning("未知的控制命令: %s", payload)

        self.publish_command_result(command, success, message, extra_data)

    def _close_serial(self):
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
                logging.info("串口连接已关闭")
        except Exception:  # noqa: BLE001
            pass

    def cleanup_resources(self):
        self.gps_streaming = False
        self._close_serial()

        try:
            if self.mqtt_client:
                self.mqtt_client.loop_stop()
                self.mqtt_client.disconnect()
                logging.info("MQTT 连接已关闭")
        except Exception:  # noqa: BLE001
            pass


def build_config_from_args() -> tuple[PublisherConfig, Optional[tuple[float, float, float]]]:
    parser = argparse.ArgumentParser(description="GPS 串口到 MQTT 发布器（命令行版）")
    parser.add_argument("--port", help="串口名称，例如 /dev/ttyAMA0")
    parser.add_argument("--baud", type=int, help="串口波特率")
    parser.add_argument("--mqtt-host", help="MQTT 服务器地址")
    parser.add_argument("--mqtt-port", type=int, help="MQTT 端口")
    parser.add_argument("--mqtt-user", help="MQTT 用户名")
    parser.add_argument("--mqtt-pass", help="MQTT 密码")
    parser.add_argument("--mqtt-topic", help="MQTT 主题")
    parser.add_argument("--device-id", help="设备 ID")
    parser.add_argument("--mqtt-control-topic", help="MQTT 控制主题，用于 start/stop/status")
    parser.add_argument("--mqtt-status-topic", help="MQTT 状态主题，用于发布设备状态")
    parser.add_argument("--mqtt-command-result-topic", help="MQTT 命令结果主题，用于接收命令执行反馈")
    parser.add_argument("--manual-lng", type=float, help="手动发布经度")
    parser.add_argument("--manual-lat", type=float, help="手动发布纬度")
    parser.add_argument("--manual-speed", type=float, help="手动发布速度 (m/s)")
    parser.add_argument("--manual", action="store_true", help="仅发布一次手动数据后退出")

    args = parser.parse_args()

    port = args.port if args.port is not None else SERIAL_PORT
    baud = args.baud if args.baud is not None else SERIAL_BAUDRATE

    config = PublisherConfig(
        port=port or "",  # 空字符串将在运行时自动检测
        baudrate=baud,
        mqtt_host=args.mqtt_host or MQTT_HOST,
        mqtt_port=args.mqtt_port or MQTT_PORT,
        mqtt_user=args.mqtt_user if args.mqtt_user is not None else MQTT_USERNAME,
        mqtt_pass=args.mqtt_pass if args.mqtt_pass is not None else MQTT_PASSWORD,
        mqtt_topic=args.mqtt_topic or MQTT_TOPIC,
        mqtt_control_topic=args.mqtt_control_topic or MQTT_CONTROL_TOPIC,
        mqtt_status_topic=args.mqtt_status_topic or MQTT_STATUS_TOPIC,
        mqtt_command_result_topic=args.mqtt_command_result_topic or MQTT_COMMAND_RESULT_TOPIC,
        device_id=args.device_id or DEVICE_ID,
        history_file=HISTORY_FILE,
    )

    manual_args = None
    if args.manual:
        manual_args = (
            args.manual_lng if args.manual_lng is not None else DEFAULT_MANUAL_LONGITUDE,
            args.manual_lat if args.manual_lat is not None else DEFAULT_MANUAL_LATITUDE,
            args.manual_speed if args.manual_speed is not None else DEFAULT_MANUAL_SPEED_MS,
        )

    return config, manual_args


def main():
    config, manual_args = build_config_from_args()
    publisher = GPSPublisher(config)

    if manual_args:
        lng, lat, speed = manual_args
        publisher.publish_manual_location(lng, lat, speed)
        return

    publisher.run()


if __name__ == "__main__":
    main()
