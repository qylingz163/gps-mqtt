#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GPS串口配置工具 - 图形界面版本
功能：选择串口、配置MQTT参数、启动/停止GPS数据发布
"""

import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
import serial
import serial.tools.list_ports
import paho.mqtt.client as mqtt
import json
import threading
import time
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from pathlib import Path


class GPSConfigGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("GPS串口配置工具")
        self.root.geometry("800x600")
        self.root.resizable(True, True)

        # 运行状态
        self.is_running = False
        self.serial_thread = None
        self.ser = None
        self.mqtt_client = None

        # 历史数据文件
        self.history_file = Path(__file__).with_name("history.jsonl")
        try:
            self.history_file.touch(exist_ok=True)
        except Exception:
            pass

        # 创建界面
        self.create_widgets()

        # 自动刷新串口列表
        self.refresh_ports()

        # 设置日志回调
        self.log_callback = None

    def create_widgets(self):
        """创建界面组件"""
        # 创建主框架
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        # 配置网格权重，使界面可调整大小
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        main_frame.columnconfigure(1, weight=1)

        # 串口配置区域
        serial_frame = ttk.LabelFrame(main_frame, text="串口配置", padding="10")
        serial_frame.grid(row=0, column=0, columnspan=2, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        serial_frame.columnconfigure(1, weight=1)

        ttk.Label(serial_frame, text="串口:").grid(row=0, column=0, sticky=tk.W, padx=(0, 10))
        self.port_var = tk.StringVar()
        self.port_combo = ttk.Combobox(serial_frame, textvariable=self.port_var, state="readonly")
        self.port_combo.grid(row=0, column=1, sticky=(tk.W, tk.E), padx=(0, 10))

        self.refresh_btn = ttk.Button(serial_frame, text="刷新", command=self.refresh_ports)
        self.refresh_btn.grid(row=0, column=2, padx=(0, 10))

        ttk.Label(serial_frame, text="波特率:").grid(row=1, column=0, sticky=tk.W, padx=(0, 10), pady=(10, 0))
        self.baud_var = tk.StringVar(value="9600")
        baud_combo = ttk.Combobox(serial_frame, textvariable=self.baud_var,
                                  values=["4800", "9600", "19200", "38400", "57600", "115200"], state="readonly")
        baud_combo.grid(row=1, column=1, sticky=(tk.W, tk.E), padx=(0, 10), pady=(10, 0))

        # MQTT配置区域
        mqtt_frame = ttk.LabelFrame(main_frame, text="MQTT配置", padding="10")
        mqtt_frame.grid(row=1, column=0, columnspan=2, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        mqtt_frame.columnconfigure(1, weight=1)

        ttk.Label(mqtt_frame, text="服务器地址:").grid(row=0, column=0, sticky=tk.W, padx=(0, 10))
        self.mqtt_host_var = tk.StringVar(value="47.121.117.89")
        mqtt_host_entry = ttk.Entry(mqtt_frame, textvariable=self.mqtt_host_var)
        mqtt_host_entry.grid(row=0, column=1, sticky=(tk.W, tk.E), padx=(0, 10))

        ttk.Label(mqtt_frame, text="端口:").grid(row=0, column=2, sticky=tk.W, padx=(0, 10))
        self.mqtt_port_var = tk.StringVar(value="1883")
        mqtt_port_entry = ttk.Entry(mqtt_frame, textvariable=self.mqtt_port_var, width=10)
        mqtt_port_entry.grid(row=0, column=3, sticky=tk.W)

        ttk.Label(mqtt_frame, text="用户名:").grid(row=1, column=0, sticky=tk.W, padx=(0, 10), pady=(10, 0))
        self.mqtt_user_var = tk.StringVar(value="")
        mqtt_user_entry = ttk.Entry(mqtt_frame, textvariable=self.mqtt_user_var)
        mqtt_user_entry.grid(row=1, column=1, sticky=(tk.W, tk.E), padx=(0, 10), pady=(10, 0))

        ttk.Label(mqtt_frame, text="密码:").grid(row=1, column=2, sticky=tk.W, padx=(0, 10), pady=(10, 0))
        self.mqtt_pass_var = tk.StringVar(value="")
        mqtt_pass_entry = ttk.Entry(mqtt_frame, textvariable=self.mqtt_pass_var, show="*")
        mqtt_pass_entry.grid(row=1, column=3, sticky=tk.W, pady=(10, 0))

        ttk.Label(mqtt_frame, text="主题:").grid(row=2, column=0, sticky=tk.W, padx=(0, 10), pady=(10, 0))
        self.mqtt_topic_var = tk.StringVar(value="student/location")
        mqtt_topic_entry = ttk.Entry(mqtt_frame, textvariable=self.mqtt_topic_var)
        mqtt_topic_entry.grid(row=2, column=1, columnspan=3, sticky=(tk.W, tk.E), padx=(0, 10), pady=(10, 0))

        # 设备ID配置
        ttk.Label(mqtt_frame, text="设备ID:").grid(row=3, column=0, sticky=tk.W, padx=(0, 10), pady=(10, 0))
        self.device_id_var = tk.StringVar(value="um220_tracker_001")
        device_id_entry = ttk.Entry(mqtt_frame, textvariable=self.device_id_var)
        device_id_entry.grid(row=3, column=1, columnspan=3, sticky=(tk.W, tk.E), padx=(0, 10), pady=(10, 0))

        # 手动发布测试数据区域
        manual_frame = ttk.LabelFrame(main_frame, text="手动发布测试数据", padding="10")
        manual_frame.grid(row=3, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))
        manual_frame.columnconfigure(1, weight=1)
        manual_frame.columnconfigure(3, weight=1)

        self.manual_lng_var = tk.StringVar(value="121.061722")
        self.manual_lat_var = tk.StringVar(value="40.885880")
        self.manual_speed_var = tk.StringVar(value="0")

        ttk.Label(manual_frame, text="经度:").grid(row=0, column=0, sticky=tk.W, padx=(0, 10))
        manual_lng_entry = ttk.Entry(manual_frame, textvariable=self.manual_lng_var)
        manual_lng_entry.grid(row=0, column=1, sticky=(tk.W, tk.E), padx=(0, 10))

        ttk.Label(manual_frame, text="纬度:").grid(row=0, column=2, sticky=tk.W, padx=(0, 10))
        manual_lat_entry = ttk.Entry(manual_frame, textvariable=self.manual_lat_var)
        manual_lat_entry.grid(row=0, column=3, sticky=(tk.W, tk.E))

        ttk.Label(manual_frame, text="速度(米/秒):").grid(row=1, column=0, sticky=tk.W, padx=(0, 10), pady=(10, 0))
        manual_speed_entry = ttk.Entry(manual_frame, textvariable=self.manual_speed_var)
        manual_speed_entry.grid(row=1, column=1, sticky=(tk.W, tk.E), padx=(0, 10), pady=(10, 0))

        manual_hint = ttk.Label(manual_frame, text="提示：MQTT连接信息以当前配置为准，适用于无设备时的测试发布。")
        manual_hint.grid(row=1, column=2, columnspan=2, sticky=tk.W, pady=(10, 0))

        manual_button = ttk.Button(manual_frame, text="发布测试数据", command=self.publish_manual_location)
        manual_button.grid(row=2, column=0, columnspan=4, pady=(15, 0))

        # 控制按钮区域
        control_frame = ttk.Frame(main_frame)
        control_frame.grid(row=4, column=0, columnspan=2, sticky=(tk.W, tk.E), pady=(0, 10))
        control_frame.columnconfigure(0, weight=1)

        self.start_btn = ttk.Button(control_frame, text="启动", command=self.start_gps)
        self.start_btn.grid(row=0, column=0, padx=(0, 10))

        self.stop_btn = ttk.Button(control_frame, text="停止", command=self.stop_gps, state=tk.DISABLED)
        self.stop_btn.grid(row=0, column=1, padx=(0, 10))

        self.clear_btn = ttk.Button(control_frame, text="清空日志", command=self.clear_log)
        self.clear_btn.grid(row=0, column=2)

        # 日志区域
        log_frame = ttk.LabelFrame(main_frame, text="日志输出", padding="10")
        log_frame.grid(row=5, column=0, columnspan=2, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        main_frame.rowconfigure(5, weight=1)

        self.log_text = scrolledtext.ScrolledText(log_frame, height=15, width=80)
        self.log_text.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        # 状态栏
        status_frame = ttk.Frame(main_frame)
        status_frame.grid(row=6, column=0, columnspan=2, sticky=(tk.W, tk.E))
        status_frame.columnconfigure(0, weight=1)

        self.status_var = tk.StringVar(value="就绪")
        status_label = ttk.Label(status_frame, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W)
        status_label.grid(row=0, column=0, sticky=(tk.W, tk.E))

        # 设置日志回调
        self.log_callback = self.add_log

    def refresh_ports(self):
        """刷新可用串口列表"""
        ports = serial.tools.list_ports.comports()
        port_list = [port.device for port in ports]

        self.port_combo['values'] = port_list
        if port_list and not self.port_var.get():
            self.port_var.set(port_list[0])

        self.add_log(f"检测到 {len(port_list)} 个串口: {', '.join(port_list)}")

    def add_log(self, message):
        """添加日志到文本区域"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_message = f"[{timestamp}] {message}\n"

        # 确保在UI线程中更新文本组件
        def update_log():
            self.log_text.insert(tk.END, log_message)
            self.log_text.see(tk.END)
            self.root.update_idletasks()

        self.root.after(0, update_log)

    def clear_log(self):
        """清空日志"""
        self.log_text.delete(1.0, tk.END)

    def publish_manual_location(self):
        """手动发布测试数据到MQTT"""
        try:
            longitude = float(self.manual_lng_var.get())
            latitude = float(self.manual_lat_var.get())
        except (TypeError, ValueError):
            messagebox.showerror("错误", "请输入有效的经纬度数值")
            return

        try:
            speed_value = float(self.manual_speed_var.get()) if self.manual_speed_var.get() else 0.0
        except (TypeError, ValueError):
            messagebox.showerror("错误", "速度请输入数字（单位：米/秒）")
            return

        mqtt_host = self.mqtt_host_var.get().strip()
        mqtt_topic = self.mqtt_topic_var.get().strip()

        if not mqtt_host:
            messagebox.showerror("错误", "请输入MQTT服务器地址")
            return

        if not mqtt_topic:
            messagebox.showerror("错误", "请输入MQTT主题")
            return

        try:
            mqtt_port = int(self.mqtt_port_var.get())
        except (TypeError, ValueError):
            messagebox.showerror("错误", "请输入有效的MQTT端口")
            return

        mqtt_user = self.mqtt_user_var.get().strip()
        mqtt_pass = self.mqtt_pass_var.get().strip()
        device_id = self.device_id_var.get().strip() or "manual_device"

        payload = {
            "message_type": "MANUAL",
            "device_id": device_id,
            "timestamp": datetime.utcnow().isoformat(),
            "latitude": latitude,
            "longitude": longitude,
            "speed_ms": speed_value,
            "speed_knots": round(speed_value / 0.51444, 3) if speed_value else 0.0,
            "source": "manual_input"
        }

        try:
            beijing_time = datetime.utcnow() + timedelta(hours=8)
            payload["time"] = beijing_time.strftime("%Y/%m/%d %H:%M:%S")
        except Exception:
            payload["time"] = datetime.now().strftime("%Y/%m/%d %H:%M:%S")

        def worker():
            client = mqtt.Client()
            if mqtt_user and mqtt_pass:
                client.username_pw_set(mqtt_user, mqtt_pass)

            try:
                client.connect(mqtt_host, mqtt_port, 60)
                client.loop_start()
                result = client.publish(mqtt_topic, json.dumps(payload, ensure_ascii=False), qos=1)
                result.wait_for_publish()
                self.append_history_file(payload)
                self.add_log(f"手动发布数据成功: 纬度={latitude}, 经度={longitude}")
            except Exception as e:
                self.add_log(f"手动发布数据失败: {e}")
                self.root.after(0, lambda: messagebox.showerror("错误", f"手动发布数据失败: {e}"))
            finally:
                try:
                    client.loop_stop()
                    client.disconnect()
                except Exception:
                    pass

        threading.Thread(target=worker, daemon=True).start()

    def start_gps(self):
        """启动GPS数据发布"""
        if self.is_running:
            messagebox.showwarning("警告", "GPS发布器已在运行中")
            return

        # 获取配置参数
        port = self.port_var.get()
        baudrate = int(self.baud_var.get())
        mqtt_host = self.mqtt_host_var.get()
        mqtt_port = int(self.mqtt_port_var.get())
        mqtt_user = self.mqtt_user_var.get()
        mqtt_pass = self.mqtt_pass_var.get()
        mqtt_topic = self.mqtt_topic_var.get()
        device_id = self.device_id_var.get()

        # 验证参数
        if not port:
            messagebox.showerror("错误", "请选择串口")
            return

        if not mqtt_host:
            messagebox.showerror("错误", "请输入MQTT服务器地址")
            return

        # 更新状态
        self.is_running = True
        self.start_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        self.status_var.set("运行中...")

        # 在新线程中启动GPS发布器
        self.serial_thread = threading.Thread(
            target=self.run_gps_publisher,
            args=(port, baudrate, mqtt_host, mqtt_port, mqtt_user, mqtt_pass, mqtt_topic, device_id),
            daemon=True
        )
        self.serial_thread.start()

        self.add_log(f"启动GPS发布器 - 串口: {port}, MQTT: {mqtt_host}:{mqtt_port}")

    def stop_gps(self):
        """停止GPS数据发布"""
        if not self.is_running:
            return

        self.is_running = False
        self.start_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)
        self.status_var.set("已停止")

        self.add_log("停止GPS发布器")

    def run_gps_publisher(self, port, baudrate, mqtt_host, mqtt_port, mqtt_user, mqtt_pass, mqtt_topic, device_id):
        """运行GPS发布器（在线程中执行）"""
        try:
            # 初始化串口连接
            self.ser = serial.Serial(
                port=port,
                baudrate=baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1
            )

            if not self.ser.is_open:
                self.add_log("错误: 无法打开串口")
                self.stop_gps()
                return

            self.add_log(f"串口连接成功: {port}")

            # 初始化MQTT连接
            self.mqtt_client = mqtt.Client()

            # 设置认证
            if mqtt_user and mqtt_pass:
                self.mqtt_client.username_pw_set(mqtt_user, mqtt_pass)

            # 设置回调
            self.mqtt_client.on_connect = self.on_mqtt_connect
            self.mqtt_client.on_disconnect = self.on_mqtt_disconnect

            # 连接MQTT
            self.mqtt_client.connect(mqtt_host, mqtt_port, 60)
            self.mqtt_client.loop_start()

            self.add_log(f"MQTT连接中: {mqtt_host}:{mqtt_port}")

            # 发送配置命令到GPS模块
            self.send_gps_commands()

            # 主循环
            last_valid_data = None
            data_count = 0

            while self.is_running:
                try:
                    # 读取串口数据
                    if self.ser.in_waiting > 0:
                        line = self.ser.readline().decode('utf-8', errors='ignore')

                        if line:
                            # 解析NMEA数据
                            gps_data = self.parse_nmea_sentence(line, device_id)

                            if gps_data:
                                # 发布到MQTT
                                self.publish_gps_data(gps_data, mqtt_topic)
                                last_valid_data = gps_data
                                data_count += 1

                                # 每10条数据更新一次状态
                                if data_count % 10 == 0:
                                    self.status_var.set(f"运行中... 已发送 {data_count} 条数据")

                except serial.SerialException as e:
                    self.add_log(f"串口错误: {e}")
                    break
                except Exception as e:
                    self.add_log(f"处理数据时出错: {e}")

                # 短暂休眠
                time.sleep(0.1)

        except Exception as e:
            self.add_log(f"GPS发布器错误: {e}")
        finally:
            # 清理资源
            self.cleanup_resources()
            self.stop_gps()

    def send_gps_commands(self):
        """发送配置命令到GPS模块"""
        config_commands = [
            b'$CFGMSG,0,,0\r\n',  # 关闭所有消息
            b'$CFGMSG,0,4,1\r\n',  # 开启RMC消息（1Hz）
            b'$CFGMSG,0,1,1\r\n',  # 开启GLL消息（1Hz）
        ]

        for cmd in config_commands:
            try:
                self.ser.write(cmd)
                self.add_log(f"发送配置命令: {cmd.decode().strip()}")
                time.sleep(0.5)  # 等待模块响应
            except Exception as e:
                self.add_log(f"发送命令失败: {e}")

    def parse_nmea_sentence(self, sentence: str, device_id: str) -> Optional[Dict[str, Any]]:
        """解析NMEA协议数据"""
        try:
            sentence = sentence.strip()

            # 检查NMEA语句格式
            if not sentence.startswith('$') or '*' not in sentence:
                return None

            # 分离数据体和校验和
            data_body, checksum = sentence[1:].split('*')
            parts = data_body.split(',')

            # 解析不同类型的NMEA语句
            nmea_type = parts[0]

            if nmea_type == 'GNRMC':  # 推荐最小定位信息
                return self.parse_rmc(parts, device_id)
            elif nmea_type == 'GNGLL':  # 地理定位信息
                return self.parse_gll(parts, device_id)
            elif nmea_type == 'GNGGA':  # GPS定位信息
                return self.parse_gga(parts, device_id)
            else:
                return None

        except Exception as e:
            self.add_log(f"NMEA解析错误: {e}")
            return None

    def parse_rmc(self, parts: list, device_id: str) -> Optional[Dict[str, Any]]:
        """解析RMC消息"""
        if len(parts) < 12:
            return None

        try:
            # 检查数据有效性
            status = parts[2]  # A=有效, V=无效
            if status != 'A':
                return None

            # 解析时间
            utc_time = parts[1]
            if utc_time and len(utc_time) >= 6:
                time_str = f"{utc_time[:2]}:{utc_time[2:4]}:{utc_time[4:6]}"
            else:
                time_str = None

            # 解析日期
            utc_date = parts[9]
            if utc_date and len(utc_date) == 6:
                date_str = f"20{utc_date[4:6]}-{utc_date[2:4]}-{utc_date[0:2]}"
            else:
                date_str = None

            # 解析纬度
            lat_dm = parts[3]
            lat_dir = parts[4]
            latitude = self.dm_to_decimal(lat_dm, lat_dir) if lat_dm else None

            # 解析经度
            lon_dm = parts[5]
            lon_dir = parts[6]
            longitude = self.dm_to_decimal(lon_dm, lon_dir, is_longitude=True) if lon_dm else None

            # 解析速度和航向
            speed_knots = float(parts[7]) if parts[7] else 0.0
            course = float(parts[8]) if parts[8] else 0.0

            # 转换为米/秒
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
                "mode": parts[12] if len(parts) > 12 else None
            }

        except (ValueError, IndexError) as e:
            self.add_log(f"RMC解析错误: {e}")
            return None

    def parse_gll(self, parts: list, device_id: str) -> Optional[Dict[str, Any]]:
        """解析GLL消息"""
        if len(parts) < 7:
            return None

        try:
            # 检查数据有效性
            status = parts[6]  # A=有效, V=无效
            if status != 'A':
                return None

            # 解析纬度
            lat_dm = parts[1]
            lat_dir = parts[2]
            latitude = self.dm_to_decimal(lat_dm, lat_dir) if lat_dm else None

            # 解析经度
            lon_dm = parts[3]
            lon_dir = parts[4]
            longitude = self.dm_to_decimal(lon_dm, lon_dir, is_longitude=True) if lon_dm else None

            # 解析时间
            utc_time = parts[5]
            if utc_time and len(utc_time) >= 6:
                time_str = f"{utc_time[:2]}:{utc_time[2:4]}:{utc_time[4:6]}"
            else:
                time_str = None

            return {
                "message_type": "GLL",
                "device_id": device_id,
                "timestamp": datetime.now().isoformat(),
                "utc_time": time_str,
                "latitude": latitude,
                "longitude": longitude,
                "status": status
            }

        except (ValueError, IndexError) as e:
            self.add_log(f"GLL解析错误: {e}")
            return None

    def parse_gga(self, parts: list, device_id: str) -> Optional[Dict[str, Any]]:
        """解析GGA消息"""
        if len(parts) < 14:
            return None

        try:
            # 解析基本信息
            utc_time = parts[1]
            if utc_time and len(utc_time) >= 6:
                time_str = f"{utc_time[:2]}:{utc_time[2:4]}:{utc_time[4:6]}"
            else:
                time_str = None

            # 解析纬度
            lat_dm = parts[2]
            lat_dir = parts[3]
            latitude = self.dm_to_decimal(lat_dm, lat_dir) if lat_dm else None

            # 解析经度
            lon_dm = parts[4]
            lon_dir = parts[5]
            longitude = self.dm_to_decimal(lon_dm, lon_dir, is_longitude=True) if lon_dm else None

            # 解析质量指标和卫星数量
            fix_quality = int(parts[6]) if parts[6] else 0
            satellites = int(parts[7]) if parts[7] else 0
            hdop = float(parts[8]) if parts[8] else 0.0  # 水平精度因子
            altitude = float(parts[9]) if parts[9] else 0.0  # 海拔高度

            return {
                "message_type": "GGA",
                "device_id": device_id,
                "timestamp": datetime.now().isoformat(),
                "utc_time": time_str,
                "latitude": latitude,
                "longitude": longitude,
                "fix_quality": fix_quality,
                "satellites": satellites,
                "hdop": hdop,
                "altitude": altitude
            }

        except (ValueError, IndexError) as e:
            self.add_log(f"GGA解析错误: {e}")
            return None

    def dm_to_decimal(self, dm_str: str, direction: str, is_longitude: bool = False) -> float:
        """将度分格式转换为十进制格式"""
        if not dm_str or not direction:
            return 0.0

        try:
            # 确定度数位数
            deg_digits = 3 if is_longitude else 2

            # 分离度和分
            degrees = float(dm_str[:deg_digits])
            minutes = float(dm_str[deg_digits:])

            # 计算十进制
            decimal = degrees + minutes / 60.0

            # 根据方向调整正负
            if direction in ['S', 'W']:
                decimal = -decimal

            # 保留6位小数
            return round(decimal, 6)

        except ValueError as e:
            self.add_log(f"坐标转换错误: {e}")
            return 0.0

    def append_history_file(self, payload: Dict[str, Any]):
        """将发布的数据附加写入本地历史文件"""
        if not self.history_file:
            return

        try:
            longitude = payload.get("longitude") or payload.get("lng")
            latitude = payload.get("latitude") or payload.get("lat")

            if longitude is None or latitude is None:
                return

            longitude = round(float(longitude), 6)
            latitude = round(float(latitude), 6)

            timestamp_value = payload.get("time") or payload.get("timestamp") or datetime.now().strftime("%Y/%m/%d %H:%M:%S")
            if isinstance(timestamp_value, (int, float)):
                if timestamp_value > 1e12:
                    dt = datetime.fromtimestamp(timestamp_value / 1000.0)
                else:
                    dt = datetime.fromtimestamp(timestamp_value)
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
                "isInsideFence": bool(payload.get("isInsideFence") or payload.get("inside_fence") or payload.get("insideFence") or False),
                "speed": speed_value,
                "deviceId": payload.get("device_id") or payload.get("deviceId"),
                "raw": payload
            }

            with self.history_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as e:
            self.add_log(f"写入历史轨迹文件失败: {e}")

    def publish_gps_data(self, gps_data: Dict[str, Any], topic: str):
        """通过MQTT发布GPS数据"""
        if not self.mqtt_client or not gps_data:
            return

        try:
            # 添加北京时间字段，格式与前端一致
            try:
                beijing_time = datetime.utcnow() + timedelta(hours=8)
                gps_data["time"] = beijing_time.strftime("%Y/%m/%d %H:%M:%S")
            except Exception:
                gps_data["time"] = datetime.now().strftime("%Y/%m/%d %H:%M:%S")

            # 添加源标识
            gps_data["source"] = "UM220-III"

            # 转换为JSON并发布
            payload = json.dumps(gps_data, ensure_ascii=False)
            result = self.mqtt_client.publish(topic, payload)

            if result.rc == mqtt.MQTT_ERR_SUCCESS:
                self.add_log(
                    f"发布 {gps_data['message_type']} 数据: 纬度={gps_data.get('latitude')}, 经度={gps_data.get('longitude')}")
                self.append_history_file(gps_data)
            else:
                self.add_log(f"发布数据失败: {result.rc}")

        except Exception as e:
            self.add_log(f"发布GPS数据异常: {e}")

    def on_mqtt_connect(self, client, userdata, flags, rc):
        """MQTT连接回调"""
        if rc == 0:
            self.add_log("MQTT连接成功")
        else:
            self.add_log(f"MQTT连接失败，错误码: {rc}")

    def on_mqtt_disconnect(self, client, userdata, rc):
        """MQTT断开连接回调"""
        self.add_log("MQTT连接断开")

    def cleanup_resources(self):
        """清理资源"""
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
                self.add_log("串口连接已关闭")
        except:
            pass

        try:
            if self.mqtt_client:
                self.mqtt_client.loop_stop()
                self.mqtt_client.disconnect()
                self.add_log("MQTT连接已关闭")
        except:
            pass


def main():
    """主函数"""
    root = tk.Tk()
    app = GPSConfigGUI(root)
    root.mainloop()


if __name__ == "__main__":
    main()
