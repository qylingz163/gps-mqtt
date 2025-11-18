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
    device_id: str
    history_file: Path


class GPSPublisher:
    """负责读取串口、解析 NMEA 并发布到 MQTT 的核心类。"""

    def __init__(self, config: PublisherConfig):
        self.config = config
        self.is_running = False
        self.ser: Optional[serial.Serial] = None
        self.mqtt_client: Optional[mqtt.Client] = None
        self.history_file = config.history_file
        self.history_file.touch(exist_ok=True)

    # ------------------------ 公共接口 ------------------------
    def run(self):
        """阻塞式运行，直到异常或按 Ctrl+C 停止。"""

        if self.is_running:
            logging.warning("GPS 发布器已在运行中")
            return

        self.is_running = True
        try:
            self._initialize_serial()
            self._initialize_mqtt()
            self.send_gps_commands()

            data_count = 0
            while self.is_running:
                try:
                    if self.ser and self.ser.in_waiting > 0:
                        line = self.ser.readline().decode("utf-8", errors="ignore")
                        if not line:
                            continue

                        gps_data = self.parse_nmea_sentence(line, self.config.device_id)
                        if not gps_data:
                            continue

                        self.publish_gps_data(gps_data, self.config.mqtt_topic)
                        data_count += 1

                        if data_count % 10 == 0:
                            logging.info("运行中... 已发送 %d 条数据", data_count)

                except serial.SerialException as exc:
                    logging.error("串口错误: %s", exc)
                    break
                except Exception as exc:  # noqa: BLE001
                    logging.error("处理数据时出错: %s", exc)

                time.sleep(0.1)

        except KeyboardInterrupt:
            logging.info("收到中断信号，准备退出...")
        except Exception as exc:  # noqa: BLE001
            logging.error("GPS 发布器错误: %s", exc)
        finally:
            self.cleanup_resources()
            self.is_running = False

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
        port = self.config.port
        if not port:
            port = self._auto_detect_port()
            logging.info("未指定串口，自动选择: %s", port)

        self.ser = serial.Serial(
            port=port,
            baudrate=self.config.baudrate,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=1,
        )

        if not self.ser.is_open:
            raise RuntimeError("无法打开串口")

        logging.info("串口连接成功: %s", port)

    def _initialize_mqtt(self):
        self.mqtt_client = mqtt.Client()

        if self.config.mqtt_user and self.config.mqtt_pass:
            self.mqtt_client.username_pw_set(self.config.mqtt_user, self.config.mqtt_pass)

        self.mqtt_client.on_connect = lambda client, userdata, flags, rc: logging.info(
            "MQTT 连接成功" if rc == 0 else "MQTT 连接失败，错误码: %s", rc
        )
        self.mqtt_client.on_disconnect = lambda client, userdata, rc: logging.info("MQTT 连接断开")

        self.mqtt_client.connect(self.config.mqtt_host, self.config.mqtt_port, 60)
        self.mqtt_client.loop_start()
        logging.info("MQTT 连接中: %s:%s", self.config.mqtt_host, self.config.mqtt_port)

    def _auto_detect_port(self) -> str:
        ports = [port.device for port in serial.tools.list_ports.comports()]
        if not ports:
            raise RuntimeError("未检测到可用串口，请检查连接")
        return ports[0]

    # ---------------------- 核心功能 ------------------------
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
            if nmea_type == "GNRMC":
                return self.parse_rmc(parts, device_id)
            if nmea_type == "GNGLL":
                return self.parse_gll(parts, device_id)
            if nmea_type == "GNGGA":
                return self.parse_gga(parts, device_id)
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

    def cleanup_resources(self):
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
                logging.info("串口连接已关闭")
        except Exception:  # noqa: BLE001
            pass

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
