# GPS MQTT Publisher (CLI)

一个面向树莓派/无图形环境的命令行 GPS 串口到 MQTT 发布脚本，支持通过 MQTT 控制启动/停止与状态查询，同时保留手动发布测试数据与历史记录写入功能。

## 功能概览
- 从串口读取 GPS 模块输出（自动或手动指定串口），解析 NMEA 语句并发布到 MQTT 主题。
- 通过控制主题接受 `start` / `stop` / `status` 命令，远程控制采集并发布设备状态消息。
- 支持命令行一次性手动发布定位数据，便于无设备调试，并将发布的数据写入 `history.jsonl`。
- 可在文件开头修改默认串口、MQTT、设备 ID、历史文件路径及手动发布默认值，或用命令行参数覆盖。

## 环境与依赖
- 建议 Python 3.9+。
- 依赖：`paho-mqtt`、`pyserial`。

安装示例：
```bash
python3 -m pip install --upgrade pip
python3 -m pip install paho-mqtt pyserial
```

## 快速开始
1. 克隆或下载本仓库，在文件开头修改默认配置（`MQTT_HOST`、`MQTT_TOPIC`、`DEVICE_ID` 等）。
2. 连接 GPS 模块到树莓派串口（默认会自动选择首个可用串口）。
3. 运行脚本：
   ```bash
   python3 main.py
   ```
   日志会在终端输出，串口数据将持续发布到 `MQTT_TOPIC`，状态消息发布到 `MQTT_STATUS_TOPIC`。

## 命令行参数
可用参数会覆盖文件开头的默认值：
```bash
python3 main.py \
  --port /dev/ttyAMA0 \
  --baud 9600 \
  --mqtt-host example.com \
  --mqtt-port 1883 \
  --mqtt-user user --mqtt-pass pass \
  --mqtt-topic student/location \
  --mqtt-control-topic student/location/control \
  --mqtt-status-topic student/location/status \
  --device-id tracker_01
```

### 手动发布测试数据
在无设备时可使用 `--manual` 模式一次性推送定位：
```bash
python3 main.py --manual --manual-lng 121.06 --manual-lat 40.88 --manual-speed 0.5
```
若未提供手动参数，将使用文件开头的 `DEFAULT_MANUAL_*` 默认值。

## MQTT 控制与状态
- 控制主题（`MQTT_CONTROL_TOPIC`）接受以下消息（纯文本或 `{"command": "..."}` JSON 均可）：
  - `start` / `resume`：开启串口读取与发布。
  - `stop` / `pause`：停止串口读取。
  - `status` / `state`：立即发布状态。
- 状态主题（`MQTT_STATUS_TOPIC`）发布的 JSON 字段示例：
  ```json
  {
    "message_type": "STATUS",
    "device_id": "um220_tracker_001",
    "running": true,
    "serial_open": true,
    "mqtt_connected": true,
    "sent_count": 42,
    "timestamp": "2024-01-01T00:00:00Z"
  }
  ```

## 历史记录
每次发布的数据（自动采集或手动发布）会追加到同目录下的 `history.jsonl`，方便追踪与调试。如需禁用，可将路径改为不可写位置或在代码中调整。
