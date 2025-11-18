"use strict";

let map = null;
let fencePolygon = null;
let mqttClient = null;
let jumpMarker = null;
let customMarkers = [];
let trackingActive = false;
let lastMessageTimestamp = 0;
let offlineTimerId = null;
const OFFLINE_TIMEOUT = 30000;
const DEFAULT_JUMP_POINT = [121.061722, 40.88588];
const deviceIdSet = new Set();
const sidebarState = {
  collapsed: false,
  userOverride: false
};

const replayPanelState = {
  collapsed: false,
  userOverride: false
};

const fencePolygonPoints = [
  [121.058244, 40.891822],
  [121.058116, 40.8828],
  [121.0685, 40.8828],
  [121.0685, 40.891822]
];

const DEFAULT_CONTROL_TOPIC = "student/location/control";
const DEFAULT_RESULT_TOPIC = "student/location/control/result";

const runtimeState = {
  isReplayMode: false,
  currentTopic: "student/location",
  controlTopic: DEFAULT_CONTROL_TOPIC,
  commandResultTopic: DEFAULT_RESULT_TOPIC
};

const elements = {};

class TrackRecorder {
  constructor(checkFenceFn, maxPoints = 2000) {
    this.checkFenceFn = checkFenceFn;
    this.maxPoints = maxPoints;
    this.history = [];
  }

  addPoint(raw) {
    const point = this._normalize(raw);
    if (!point) {
      return null;
    }

    this.history.push(point);
    if (this.history.length > this.maxPoints) {
      this.history.shift();
    }
    return point;
  }

  createPoint(raw) {
    return this._normalize(raw);
  }

  setHistory(points) {
    this.history = points.slice(-this.maxPoints);
    return this.history;
  }

  getLatest() {
    return this.history.length ? this.history[this.history.length - 1] : null;
  }

  _normalize(raw) {
    if (!raw) {
      return null;
    }

    const longitude = Number(raw.longitude ?? raw.lng);
    const latitude = Number(raw.latitude ?? raw.lat);

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return null;
    }

    const dateValue = ensureDate(raw.time ?? raw.timestamp ?? Date.now());
    const speedValue = Number(
      raw.speed_ms ?? raw.speed ?? raw.speed_knots ?? raw.speedMps ?? 0
    );

    let insideFence = raw.isInsideFence;
    if (typeof insideFence !== "boolean" && this.checkFenceFn) {
      insideFence = this.checkFenceFn(longitude, latitude);
    }

    const deviceId = String(
      raw.device_id ?? raw.deviceId ?? raw.device ?? "device"
    );

    return {
      lng: Number(longitude.toFixed(6)),
      lat: Number(latitude.toFixed(6)),
      timestamp: dateValue.toISOString(),
      displayTime: formatDisplayTime(dateValue),
      speed: Number.isFinite(speedValue) ? Number(speedValue.toFixed(2)) : 0,
      isInsideFence: Boolean(insideFence),
      deviceId,
      raw
    };
  }
}

class PlaybackController {
  constructor(recorder, ui) {
    this.recorder = recorder;
    this.ui = ui;
    this.map = null;
    this.marker = null;
    this.trackLine = null;
    this.state = {
      isPlaying: false,
      currentIndex: 0,
      playbackSpeed: 1,
      intervalId: null
    };
    this.speeds = [0.5, 1, 2, 5];
  }

  attachMap(mapInstance) {
    this.map = mapInstance;
  }

  refreshTimeline() {
    const total = this.recorder.history.length;
    if (this.ui.timeSlider) {
      this.ui.timeSlider.max = total ? total - 1 : 0;
      if (this.state.currentIndex > total - 1) {
        this.state.currentIndex = Math.max(total - 1, 0);
      }
    }

    if (this.ui.totalTime) {
      const lastPoint = this.recorder.getLatest();
      this.ui.totalTime.textContent = lastPoint
        ? lastPoint.displayTime
        : "--:--:--";
    }

    if (!total && this.ui.currentTime) {
      this.ui.currentTime.textContent = "--:--:--";
    }
  }

  updateDisplay() {
    const point = this.recorder.history[this.state.currentIndex];
    if (!point) {
      if (this.ui.timeSlider) {
        this.ui.timeSlider.value = 0;
      }
      if (this.ui.currentTime) {
        this.ui.currentTime.textContent = "--:--:--";
      }
      return;
    }

    if (this.ui.timeSlider) {
      this.ui.timeSlider.value = this.state.currentIndex;
    }
    if (this.ui.currentTime) {
      this.ui.currentTime.textContent = point.displayTime;
    }

    this.updateMapDisplay(point);
  }

  updateMapDisplay(point) {
    if (!this.map) {
      return;
    }

    const path = this.recorder.history
      .slice(0, this.state.currentIndex + 1)
      .map((p) => [p.lng, p.lat]);

    if (!this.marker) {
      this.marker = new AMap.Marker({
        position: [point.lng, point.lat],
        map: this.map,
        content: this.createMarkerContent(point.isInsideFence),
        offset: new AMap.Pixel(-10, -10)
      });
    } else {
      this.marker.setPosition([point.lng, point.lat]);
      this.marker.setContent(this.createMarkerContent(point.isInsideFence));
    }
    this.marker.setTitle(`时间: ${point.displayTime}`);

    if (!this.trackLine) {
      this.trackLine = new AMap.Polyline({
        map: this.map,
        path,
        strokeColor: point.isInsideFence ? "#FF4D4F" : "#1890ff",
        strokeWeight: 4,
        strokeOpacity: 0.85
      });
    } else {
      this.trackLine.setPath(path);
      this.trackLine.setOptions({
        strokeColor: point.isInsideFence ? "#FF4D4F" : "#1890ff"
      });
    }

    if (typeof this.map.panTo === "function") {
      this.map.panTo([point.lng, point.lat]);
    } else {
      this.map.setCenter([point.lng, point.lat]);
    }
  }

  createMarkerContent(isInside) {
    const color = isInside ? "#FF4D4F" : "#1890ff";
    return `
      <div style="
        width: 20px;
        height: 20px;
        background: ${color};
        border-radius: 50%;
        border: 2px solid #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      "></div>
    `;
  }

  togglePlayback() {
    if (this.state.isPlaying) {
      this.pausePlayback();
    } else {
      this.startPlayback();
    }
  }

  startPlayback() {
    if (this.recorder.history.length === 0) {
      alert("暂无轨迹数据可播放");
      return;
    }

    this.pausePlayback();
    if (
      this.state.currentIndex >= this.recorder.history.length - 1 ||
      this.state.currentIndex < 0
    ) {
      this.state.currentIndex = 0;
    }

    this.state.isPlaying = true;
    if (this.ui.playPauseBtn) {
      this.ui.playPauseBtn.textContent = "⏸️ 暂停";
    }

    const interval = 1000 / this.state.playbackSpeed;
    this.state.intervalId = window.setInterval(() => {
      if (this.state.currentIndex < this.recorder.history.length - 1) {
        this.state.currentIndex += 1;
        this.updateDisplay();
      } else {
        this.pausePlayback();
      }
    }, interval);
  }

  pausePlayback() {
    this.state.isPlaying = false;
    if (this.state.intervalId) {
      window.clearInterval(this.state.intervalId);
      this.state.intervalId = null;
    }
    if (this.ui.playPauseBtn) {
      this.ui.playPauseBtn.textContent = "▶️ 播放";
    }
  }

  changeSpeed() {
    const idx = this.speeds.indexOf(this.state.playbackSpeed);
    const nextSpeed = this.speeds[(idx + 1) % this.speeds.length];
    this.state.playbackSpeed = nextSpeed;
    if (this.ui.speedControl) {
      this.ui.speedControl.textContent = `${nextSpeed}x`;
    }
    if (this.state.isPlaying) {
      this.startPlayback();
    }
  }

  resetPlayback() {
    this.pausePlayback();
    this.state.currentIndex = 0;
    this.updateDisplay();
  }

  jumpToPoint(index) {
    if (!this.recorder.history.length) {
      return;
    }
    const clamped = Math.max(0, Math.min(index, this.recorder.history.length - 1));
    this.state.currentIndex = clamped;
    this.updateDisplay();
  }

  syncToLatest() {
    if (!this.recorder.history.length) {
    return;
    }
    this.state.currentIndex = this.recorder.history.length - 1;
    this.updateDisplay();
  }
}

const trackRecorder = new TrackRecorder((lng, lat) =>
  isPointInPolygon([lng, lat], fencePolygonPoints)
);
let playbackController = null;

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  resetLiveInfo();
  initMap();
  playbackController = new PlaybackController(trackRecorder, elements);
  playbackController.attachMap(map);
  setupEventListeners();
  playbackController.refreshTimeline();
  syncSidebarStateFromDom();
  syncReplayPanelStateFromDom();
  handleResponsiveSidebar(true);
  handleResponsiveReplayPanel(true);
  startOfflineWatcher();
  startTracking();
  setupConsoleWindow();
  appendConsoleLog("命令终端已就绪，可在连接 MQTT 后下发控制命令。", "info");
});

function cacheElements() {
  elements.protocolSelect = document.getElementById("mqtt_protocol");
  elements.mqttHost = document.getElementById("mqtt_host");
  elements.mqttPort = document.getElementById("mqtt_port");
  elements.mqttPath = document.getElementById("mqtt_path");
  elements.mqttTopic = document.getElementById("mqtt_topic");
  elements.mqttUser = document.getElementById("mqtt_user");
  elements.mqttPass = document.getElementById("mqtt_pass");
  elements.mqttClientId = document.getElementById("mqtt_client_id");

  elements.manualLng = document.getElementById("manualLng");
  elements.manualLat = document.getElementById("manualLat");
  elements.manualSpeed = document.getElementById("manualSpeed");

  elements.positionLng = document.getElementById("position_lng");
  elements.positionLat = document.getElementById("position_lat");
  elements.positionLngGps = document.getElementById("position_lng_gps");
  elements.positionLatGps = document.getElementById("position_lat_gps");
  elements.trackingStatus = document.getElementById("tracking_status");

  elements.timeSlider = document.getElementById("timeSlider");
  elements.currentTime = document.getElementById("currentTime");
  elements.totalTime = document.getElementById("totalTime");
  elements.playPauseBtn = document.getElementById("playPauseBtn");
  elements.speedControl = document.getElementById("speedControl");
  elements.resetBtn = document.getElementById("resetBtn");
  elements.exportBtn = document.getElementById("exportBtn");
  elements.toggleReplay = document.getElementById("toggleReplayMode");
  elements.mqttStatus = document.getElementById("mqtt_status");

  elements.replayDialog = document.getElementById("replayDialog");
  elements.replayDeviceId = document.getElementById("replayDeviceId");
  elements.replayStartTime = document.getElementById("replayStartTime");
  elements.replayEndTime = document.getElementById("replayEndTime");

  elements.sidebar = document.getElementById("sidebar");
  elements.sidebarCollapseBtn = document.getElementById("sidebarCollapseBtn");
  elements.sidebarExpandBtn = document.getElementById("sidebarExpandBtn");
  elements.replayPanel = document.getElementById("replayPanel");
  elements.replayPanelCollapseBtn = document.getElementById("replayPanelCollapseBtn");
  elements.replayPanelExpandBtn = document.getElementById("replayPanelExpandBtn");
  elements.offlineBanner = document.getElementById("offline_banner");
  elements.liveInfo = document.getElementById("live_info");
  elements.liveInfoDevice = document.getElementById("live_info_device");
  elements.liveInfoCoords = document.getElementById("live_info_coords");
  elements.liveInfoSpeed = document.getElementById("live_info_speed");
  elements.liveInfoFence = document.getElementById("live_info_fence");
  elements.liveInfoTime = document.getElementById("live_info_time");

  elements.consoleWindow = document.getElementById("commandConsole");
  elements.consoleHeader = document.getElementById("consoleDragHandle");
  elements.consoleBody = document.getElementById("consoleBody");
  elements.consoleOutput = document.getElementById("consoleOutput");
  elements.consoleCommand = document.getElementById("consoleCommand");
  elements.consolePreset = document.getElementById("consolePreset");
  elements.consoleSendBtn = document.getElementById("consoleSendBtn");
  elements.consoleClearBtn = document.getElementById("consoleClearBtn");
  elements.consoleCollapseBtn = document.getElementById("consoleCollapseBtn");
  elements.mqttControlTopic = document.getElementById("mqtt_control_topic");
  elements.mqttResultTopic = document.getElementById("mqtt_result_topic");
}

function initMap() {
  map = new AMap.Map("container", {
    resizeEnable: true,
    zoom: 15,
    center: fencePolygonPoints[0]
  });

  AMap.plugin(["AMap.ToolBar", "AMap.Scale"], () => {
    map.addControl(new AMap.ToolBar());
    map.addControl(new AMap.Scale());
  });

  fencePolygon = new AMap.Polygon({
    map,
    path: fencePolygonPoints,
    strokeColor: "#FF4D4F",
        strokeWeight: 3,
    strokeOpacity: 0.9,
    fillOpacity: 0.15,
    fillColor: "#FF4D4F"
  });

  map.setFitView([fencePolygon]);
}

function setupEventListeners() {
  if (elements.timeSlider) {
    elements.timeSlider.addEventListener("input", (evt) => {
      const value = Number(evt.target.value || 0);
      playbackController.jumpToPoint(value);
    });
  }

  if (elements.playPauseBtn) {
    elements.playPauseBtn.addEventListener("click", () =>
      playbackController.togglePlayback()
    );
  }

  if (elements.speedControl) {
    elements.speedControl.addEventListener("click", () =>
      playbackController.changeSpeed()
    );
  }

  if (elements.resetBtn) {
    elements.resetBtn.addEventListener("click", () =>
      playbackController.resetPlayback()
    );
  }

  if (elements.exportBtn) {
    elements.exportBtn.addEventListener("click", exportTrackHistory);
  }

  if (elements.toggleReplay) {
    elements.toggleReplay.addEventListener("click", toggleReplayMode);
  }

  if (elements.sidebarCollapseBtn) {
    elements.sidebarCollapseBtn.addEventListener("click", () =>
      toggleSidebar(false)
    );
  }

  if (elements.sidebarExpandBtn) {
    elements.sidebarExpandBtn.addEventListener("click", () =>
      toggleSidebar(true)
    );
  }

  if (elements.replayPanelCollapseBtn) {
    elements.replayPanelCollapseBtn.addEventListener("click", () =>
      toggleReplayPanel(false)
    );
  }

  if (elements.replayPanelExpandBtn) {
    elements.replayPanelExpandBtn.addEventListener("click", () =>
      toggleReplayPanel(true)
    );
  }

  if (elements.consoleSendBtn) {
    elements.consoleSendBtn.addEventListener("click", sendConsoleCommand);
  }

  if (elements.consoleCommand) {
    elements.consoleCommand.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        sendConsoleCommand();
      }
    });
  }

  if (elements.consolePreset && elements.consoleCommand) {
    elements.consolePreset.addEventListener("change", (evt) => {
      const value = evt.target.value || "";
      if (value) {
        elements.consoleCommand.value = value;
      }
      elements.consoleCommand.focus();
    });
  }

  if (elements.consoleClearBtn) {
    elements.consoleClearBtn.addEventListener("click", clearConsoleOutput);
  }

  if (elements.consoleCollapseBtn) {
    elements.consoleCollapseBtn.addEventListener("click", toggleConsoleCollapse);
  }

  window.addEventListener("resize", () => {
    handleResponsiveSidebar();
    handleResponsiveReplayPanel();
  });

  document.addEventListener("keydown", (evt) => {
    if (
      evt.key === "Escape" &&
      elements.replayDialog &&
      elements.replayDialog.classList.contains("open")
    ) {
      closeReplayDialog();
    }
  });

  window.connectMQTTFromForm = connectMQTTFromForm;
  window.disconnectMQTT = disconnectMQTT;
  window.addManualPoint = addManualPoint;
  window.addMarker = addMarker;
  window.addMarker2 = addMarker2;
  window.addMarkerGPS = addMarkerGPS;
  window.clearMarkers = clearMarkers;
  window.switchMapType = switchMapType;
  window.startTracking = startTracking;
  window.stopTracking = stopTracking;
  window.pauseReplay = pauseReplay;
  window.stopReplay = stopReplay;
  window.clearHistoryTrack = clearHistoryTrack;
  window.showReplayDialog = showReplayDialog;
  window.closeReplayDialog = closeReplayDialog;
  window.confirmReplay = confirmReplay;
}

async function toggleReplayMode() {
  if (!elements.toggleReplay) {
    return;
  }

  if (!runtimeState.isReplayMode) {
    elements.toggleReplay.disabled = true;
    const originalText = elements.toggleReplay.textContent;
    elements.toggleReplay.textContent = "加载中...";

    const loaded = await loadHistoryFromFile();
    elements.toggleReplay.disabled = false;

    if (!loaded) {
      elements.toggleReplay.textContent = originalText || "进入回放模式";
      alert("history.jsonl 暂无可回放的数据");
        return;
    }
    
    runtimeState.isReplayMode = true;
    elements.toggleReplay.textContent = "退出回放模式";
    playbackController.resetPlayback();
    playbackController.updateDisplay();
  } else {
    runtimeState.isReplayMode = false;
    elements.toggleReplay.textContent = "进入回放模式";
    playbackController.pausePlayback();
    playbackController.syncToLatest();
  }
}

async function loadHistoryFromFile(filters = {}) {
  try {
    const response = await fetch(`./history.jsonl?ts=${Date.now()}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      return 0;
    }

    const text = await response.text();
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const points = [];
    const deviceIdsInFile = new Set();
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        const raw = data.raw ?? data;
        const merged = {
          longitude: data.lng ?? raw.longitude,
          latitude: data.lat ?? raw.latitude,
          time: data.timestamp ?? data.time ?? raw.time ?? raw.timestamp,
          speed: data.speed ?? raw.speed_ms ?? raw.speed ?? 0,
          isInsideFence: data.isInsideFence,
          device_id: data.deviceId ?? raw.device_id ?? raw.deviceId
        };
        const point = trackRecorder.createPoint(merged);
        if (point) {
          points.push(point);
          deviceIdsInFile.add(point.deviceId);
        }
      } catch (parseError) {
        console.warn("解析历史轨迹失败", parseError);
      }
    }

    deviceIdsInFile.forEach((id) => registerDeviceId(id));

    const startMs =
      typeof filters.startTimeMs === "number" && Number.isFinite(filters.startTimeMs)
        ? filters.startTimeMs
        : null;
    const endMs =
      typeof filters.endTimeMs === "number" && Number.isFinite(filters.endTimeMs)
        ? filters.endTimeMs
        : null;
    const targetDevice =
      typeof filters.deviceId === "string" && filters.deviceId !== "all"
        ? filters.deviceId
        : null;

    const filteredPoints = points.filter((point) => {
      if (targetDevice && point.deviceId !== targetDevice) {
        return false;
      }
      const timestampMs = Date.parse(point.timestamp);
      if (startMs !== null && !Number.isNaN(timestampMs) && timestampMs < startMs) {
        return false;
      }
      if (endMs !== null && !Number.isNaN(timestampMs) && timestampMs > endMs) {
        return false;
      }
      return true;
    });

    if (filteredPoints.length) {
      trackRecorder.setHistory(filteredPoints);
    } else {
      trackRecorder.setHistory([]);
    }
    playbackController.refreshTimeline();
    playbackController.pausePlayback();
    playbackController.state.currentIndex = 0;

    return filteredPoints.length;
  } catch (error) {
    console.warn("加载历史轨迹失败", error);
    alert("读取 history.jsonl 时发生错误，请确认文件已放在前端目录下。");
    return 0;
  }
}

function startOfflineWatcher() {
  if (offlineTimerId) {
    window.clearInterval(offlineTimerId);
  }
  offlineTimerId = window.setInterval(() => {
    if (!trackingActive) {
      setOfflineBanner(false);
      return;
    }
    if (!lastMessageTimestamp) {
      return;
    }
    const delta = Date.now() - lastMessageTimestamp;
    setOfflineBanner(delta > OFFLINE_TIMEOUT);
  }, 5000);
}

function setOfflineBanner(visible) {
  if (!elements.offlineBanner) {
    return;
  }
  elements.offlineBanner.style.display = visible ? "block" : "none";
}

function setTrackingStatus(text, color) {
  if (!elements.trackingStatus) {
    return;
  }
  elements.trackingStatus.textContent = text;
  if (color) {
    elements.trackingStatus.style.color = color;
  }
}

function resetLiveInfo() {
  if (!elements.liveInfo) {
    return;
  }
  elements.liveInfo.classList.remove("has-data");
  if (elements.liveInfoDevice) {
    elements.liveInfoDevice.textContent = "--";
  }
  if (elements.liveInfoCoords) {
    elements.liveInfoCoords.textContent = "--";
  }
  if (elements.liveInfoSpeed) {
    elements.liveInfoSpeed.textContent = "--";
  }
  if (elements.liveInfoTime) {
    elements.liveInfoTime.textContent = "--:--:--";
  }
  if (elements.liveInfoFence) {
    elements.liveInfoFence.textContent = "围栏状态 --";
    elements.liveInfoFence.classList.remove("is-outside");
  }
}

function updateLiveInfo(point) {
  if (!point || !elements.liveInfo) {
    return;
  }
  elements.liveInfo.classList.add("has-data");

  if (elements.liveInfoDevice) {
    elements.liveInfoDevice.textContent = point.deviceId || "--";
  }

  if (elements.liveInfoCoords) {
    const lngText = Number.isFinite(point.lng) ? point.lng.toFixed(6) : "--";
    const latText = Number.isFinite(point.lat) ? point.lat.toFixed(6) : "--";
    elements.liveInfoCoords.textContent = `${lngText}, ${latText}`;
  }

  if (elements.liveInfoSpeed) {
    const speedValue = Number.isFinite(point.speed) ? point.speed : 0;
    const kmh = (speedValue * 3.6).toFixed(2);
    elements.liveInfoSpeed.textContent = `${speedValue.toFixed(2)} 米/秒 (${kmh} 公里/小时)`;
  }

  if (elements.liveInfoTime) {
    elements.liveInfoTime.textContent = point.displayTime || "--:--:--";
  }

  if (elements.liveInfoFence) {
    const inside = Boolean(point.isInsideFence);
    elements.liveInfoFence.textContent = inside ? "围栏内" : "围栏外";
    elements.liveInfoFence.classList.toggle("is-outside", !inside);
  }
}

function startTracking() {
  trackingActive = true;
  setTrackingStatus("跟踪中", "#52c41a");
  setOfflineBanner(false);
  if (!runtimeState.isReplayMode && trackRecorder.history.length) {
    playbackController.syncToLatest();
  }
}

function stopTracking() {
  trackingActive = false;
  setTrackingStatus("已暂停", "#999");
  setOfflineBanner(false);
  playbackController.pausePlayback();
}

function pauseReplay() {
  playbackController.pausePlayback();
}

function stopReplay() {
  runtimeState.isReplayMode = false;
  playbackController.pausePlayback();
  playbackController.resetPlayback();
  playbackController.updateDisplay();
  if (elements.toggleReplay) {
    elements.toggleReplay.textContent = "进入回放模式";
  }
}

function clearHistoryTrack() {
  trackRecorder.setHistory([]);
  playbackController.pausePlayback();
  playbackController.refreshTimeline();
  playbackController.state.currentIndex = 0;
  resetLiveInfo();
  if (playbackController.marker) {
    playbackController.marker.setMap(null);
    playbackController.marker = null;
  }
  if (playbackController.trackLine) {
    playbackController.trackLine.setMap(null);
    playbackController.trackLine = null;
  }
  runtimeState.isReplayMode = false;
  lastMessageTimestamp = 0;
  setOfflineBanner(false);
  if (elements.toggleReplay) {
    elements.toggleReplay.textContent = "进入回放模式";
  }
  alert("历史轨迹已清除");
}

function showReplayDialog() {
  if (!elements.replayDialog) {
    return;
  }
  elements.replayDialog.classList.add("open");
  document.body.classList.add("dialog-open");
}

function closeReplayDialog() {
  if (!elements.replayDialog) {
    return;
  }
  elements.replayDialog.classList.remove("open");
  document.body.classList.remove("dialog-open");
}

function confirmReplay() {
  const filters = {};
  const deviceId = elements.replayDeviceId ? elements.replayDeviceId.value : "all";
  const startValue = elements.replayStartTime ? elements.replayStartTime.value : "";
  const endValue = elements.replayEndTime ? elements.replayEndTime.value : "";

  if (deviceId && deviceId !== "all") {
    filters.deviceId = deviceId;
  }

  if (startValue) {
    const parsedStart = Date.parse(startValue);
    if (Number.isNaN(parsedStart)) {
      alert("开始时间格式不正确");
      return;
    }
    filters.startTimeMs = parsedStart;
  }

  if (endValue) {
    const parsedEnd = Date.parse(endValue);
    if (Number.isNaN(parsedEnd)) {
      alert("结束时间格式不正确");
      return;
    }
    filters.endTimeMs = parsedEnd;
  }

  if (
    typeof filters.startTimeMs === "number" &&
    typeof filters.endTimeMs === "number" &&
    filters.startTimeMs > filters.endTimeMs
  ) {
    alert("开始时间不能晚于结束时间");
    return;
  }

  loadHistoryFromFile(filters)
    .then((loaded) => {
      if (!loaded) {
        alert("未找到匹配的轨迹数据");
        return;
      }
      runtimeState.isReplayMode = true;
      if (elements.toggleReplay) {
        elements.toggleReplay.textContent = "退出回放模式";
      }
      playbackController.resetPlayback();
      playbackController.updateDisplay();
    })
    .finally(() => {
      closeReplayDialog();
    });
}

function toggleSidebar(open, userTriggered = true) {
  if (typeof open === "boolean") {
    setSidebarCollapsed(!open, userTriggered);
    return;
  }
  setSidebarCollapsed(!sidebarState.collapsed, userTriggered);
}

function setSidebarCollapsed(collapsed, userTriggered = false) {
  if (sidebarState.collapsed === collapsed) {
    if (userTriggered) {
      sidebarState.userOverride = true;
    }
    sidebarState.collapsed = collapsed;
    // 即便状态未变化，也同步 DOM 以防样式缺失
    if (collapsed) {
      document.body.classList.add("sidebar-collapsed");
    } else {
      document.body.classList.remove("sidebar-collapsed");
    }
    return;
  }

  sidebarState.collapsed = collapsed;
  if (userTriggered) {
    sidebarState.userOverride = true;
  }

  if (collapsed) {
    document.body.classList.add("sidebar-collapsed");
  } else {
    document.body.classList.remove("sidebar-collapsed");
  }
}

function handleResponsiveSidebar(initial = false) {
  if (sidebarState.userOverride && !initial) {
    return;
  }
  const shouldCollapse = window.innerWidth < 1100;
  setSidebarCollapsed(shouldCollapse, false);
}

function syncSidebarStateFromDom() {
  sidebarState.collapsed = document.body.classList.contains("sidebar-collapsed");
  if (!sidebarState.collapsed) {
    sidebarState.userOverride = false;
  }
}

function toggleReplayPanel(open, userTriggered = true) {
  if (typeof open === "boolean") {
    setReplayPanelCollapsed(!open, userTriggered);
    return;
  }
  setReplayPanelCollapsed(!replayPanelState.collapsed, userTriggered);
}

function setReplayPanelCollapsed(collapsed, userTriggered = false) {
  if (replayPanelState.collapsed === collapsed) {
    if (userTriggered) {
      replayPanelState.userOverride = true;
    }
    replayPanelState.collapsed = collapsed;
    if (collapsed) {
      document.body.classList.add("replay-panel-collapsed");
    } else {
      document.body.classList.remove("replay-panel-collapsed");
    }
    return;
  }

  replayPanelState.collapsed = collapsed;
  if (userTriggered) {
    replayPanelState.userOverride = true;
  }

  if (collapsed) {
    document.body.classList.add("replay-panel-collapsed");
  } else {
    document.body.classList.remove("replay-panel-collapsed");
  }
}

function handleResponsiveReplayPanel(initial = false) {
  if (replayPanelState.userOverride && !initial) {
    return;
  }
  const shouldCollapse = window.innerWidth < 1280;
  setReplayPanelCollapsed(shouldCollapse, false);
}

function syncReplayPanelStateFromDom() {
  replayPanelState.collapsed = document.body.classList.contains("replay-panel-collapsed");
  if (!replayPanelState.collapsed) {
    replayPanelState.userOverride = false;
  }
}

function ensureJumpMarker() {
  if (jumpMarker) {
    return jumpMarker;
  }
  if (!map) {
    return null;
  }
  jumpMarker = new AMap.Marker({
    position: map.getCenter(),
    map,
    icon: "https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png",
    title: "定位点"
  });
  rememberCustomMarker(jumpMarker);
  return jumpMarker;
}

function rememberCustomMarker(marker) {
  if (!marker) {
    return;
  }
  if (!customMarkers.includes(marker)) {
    customMarkers.push(marker);
  }
}

function focusOnPosition(lng, lat, options = {}) {
  if (!map || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    return;
  }
  const marker = ensureJumpMarker();
  if (marker) {
    marker.setPosition([lng, lat]);
  }
  if (elements.positionLng) {
    elements.positionLng.value = Number(lng).toFixed(6);
  }
  if (elements.positionLat) {
    elements.positionLat.value = Number(lat).toFixed(6);
  }
  map.setCenter([lng, lat]);
  if (typeof options.zoom === "number") {
    map.setZoom(options.zoom);
  } else if (map.getZoom() < 15) {
    map.setZoom(15);
  }
  if (options.toast) {
    alert(options.toast);
  }
}

function addMarker() {
  if (!elements.positionLng || !elements.positionLat) {
    return;
  }
  const lng = parseFloat(elements.positionLng.value || "");
  const lat = parseFloat(elements.positionLat.value || "");
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    alert("请输入有效的经纬度数值");
    return;
  }
  focusOnPosition(lng, lat);
}

function addMarker2() {
  if (elements.positionLng) {
    elements.positionLng.value = DEFAULT_JUMP_POINT[0];
  }
  if (elements.positionLat) {
    elements.positionLat.value = DEFAULT_JUMP_POINT[1];
  }
  focusOnPosition(DEFAULT_JUMP_POINT[0], DEFAULT_JUMP_POINT[1], { zoom: 14 });
}

function addMarkerGPS() {
  if (!elements.positionLngGps || !elements.positionLatGps) {
    return;
  }
  const lng = parseFloat(elements.positionLngGps.value || "");
  const lat = parseFloat(elements.positionLatGps.value || "");
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    alert("请输入有效的GPS经纬度数值");
    return;
  }
  const source = [lng, lat];

  const handleResult = (resultLng, resultLat, message) => {
    focusOnPosition(resultLng, resultLat, { toast: message });
  };

  if (typeof AMap !== "undefined" && typeof AMap.convertFrom === "function") {
    AMap.convertFrom(source, "gps", (status, result) => {
      if (
        status === "complete" &&
        result &&
        result.info === "ok" &&
        result.locations &&
        result.locations.length > 0
      ) {
        const dest = result.locations[0];
        handleResult(dest.lng, dest.lat, "GPS坐标跳转成功！");
      } else {
        const [convertedLng, convertedLat] = gpsToGCJ(source[0], source[1]);
        handleResult(convertedLng, convertedLat, "GPS坐标跳转成功（离线转换）！");
      }
    });
  } else {
    const [convertedLng, convertedLat] = gpsToGCJ(source[0], source[1]);
    handleResult(convertedLng, convertedLat, "GPS坐标跳转成功（离线转换）！");
  }
}

function clearMarkers() {
  customMarkers.forEach((marker) => {
    try {
      marker.setMap(null);
    } catch (error) {
      console.warn("移除标记失败", error);
    }
  });
  customMarkers = [];
  jumpMarker = null;
  alert("所有自定义标记已清除");
}

function switchMapType(type) {
  if (!map || typeof AMap === "undefined") {
    return;
  }
  switch (type) {
    case "satellite":
      map.setLayers([new AMap.TileLayer.Satellite()]);
      break;
    case "road":
      map.setLayers([new AMap.TileLayer.RoadNet()]);
      break;
    default:
      map.setLayers([new AMap.TileLayer()]);
      break;
  }
}

function registerDeviceId(deviceId) {
  if (!deviceId || deviceId === "all" || deviceIdSet.has(deviceId)) {
    return;
  }
  deviceIdSet.add(deviceId);
  if (!elements.replayDeviceId) {
    return;
  }
  const exists = Array.from(elements.replayDeviceId.options).some(
    (option) => option.value === deviceId
  );
  if (exists) {
    return;
  }
  const option = document.createElement("option");
  option.value = deviceId;
  option.textContent = deviceId;
  elements.replayDeviceId.appendChild(option);
}

function handleIncomingPoint(raw) {
  const point = trackRecorder.addPoint(raw);
  if (!point) {
    return;
  }

  lastMessageTimestamp = Date.now();
  setOfflineBanner(false);
  registerDeviceId(point.deviceId);

  playbackController.refreshTimeline();
  updateLiveInfo(point);

  if (!trackingActive) {
    return;
  }

  if (!runtimeState.isReplayMode) {
    playbackController.syncToLatest();
  }
}

function sendConsoleCommand() {
  const commandText = (elements.consoleCommand?.value || "").trim();
  const preset = elements.consolePreset?.value || "";
  const command = commandText || preset;

  if (!command) {
    appendConsoleLog("请输入要发送的命令", "error");
    return;
  }

  if (!mqttClient || !mqttClient.connected) {
    appendConsoleLog("MQTT 未连接，无法发送命令", "error");
    return;
  }

  const controlTopic =
    (elements.mqttControlTopic?.value || DEFAULT_CONTROL_TOPIC).trim() ||
    DEFAULT_CONTROL_TOPIC;
  const resultTopic =
    (elements.mqttResultTopic?.value || DEFAULT_RESULT_TOPIC).trim() ||
    DEFAULT_RESULT_TOPIC;

  runtimeState.controlTopic = controlTopic;
  runtimeState.commandResultTopic = resultTopic;

  try {
    mqttClient.publish(controlTopic, JSON.stringify({ command }));
    appendConsoleLog(`已发送: ${command}`, "info");
  } catch (error) {
    appendConsoleLog(`发送失败: ${error?.message || error}`, "error");
  }
}

function appendConsoleLog(message, type = "info") {
  if (!elements.consoleOutput) {
    return;
  }

  const line = document.createElement("div");
  line.className = "log-line";
  if (type === "error") {
    line.classList.add("is-error");
  } else if (type === "success") {
    line.classList.add("is-success");
  }

  const timestamp = document.createElement("span");
  timestamp.className = "timestamp";
  timestamp.textContent = new Date().toLocaleTimeString();
  line.appendChild(timestamp);

  const messageEl = document.createElement("pre");
  messageEl.className = "message";
  messageEl.textContent = message;
  line.appendChild(messageEl);

  elements.consoleOutput.appendChild(line);
  elements.consoleOutput.scrollTop = elements.consoleOutput.scrollHeight;
}

function clearConsoleOutput() {
  if (elements.consoleOutput) {
    elements.consoleOutput.innerHTML = "";
  }
}

function toggleConsoleCollapse() {
  if (!elements.consoleWindow || !elements.consoleCollapseBtn) {
    return;
  }
  elements.consoleWindow.classList.toggle("is-collapsed");
  const isCollapsed = elements.consoleWindow.classList.contains("is-collapsed");
  elements.consoleCollapseBtn.textContent = isCollapsed ? "＋" : "—";
}

function setupConsoleWindow() {
  if (!elements.consoleWindow || !elements.consoleHeader) {
    return;
  }

  const windowEl = elements.consoleWindow;
  const headerEl = elements.consoleHeader;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let widthSnapshot = 0;
  let heightSnapshot = 0;
  let activePointerId = null;

  const onPointerMove = (evt) => {
    if (!isDragging) {
      return;
    }
    const nextLeft = Math.min(
      Math.max(0, evt.clientX - dragOffsetX),
      Math.max(0, window.innerWidth - widthSnapshot)
    );
    const nextTop = Math.min(
      Math.max(0, evt.clientY - dragOffsetY),
      Math.max(0, window.innerHeight - heightSnapshot)
    );
    windowEl.style.left = `${nextLeft}px`;
    windowEl.style.top = `${nextTop}px`;
  };

  const endDrag = () => {
    isDragging = false;
    if (activePointerId !== null) {
      headerEl.releasePointerCapture?.(activePointerId);
      activePointerId = null;
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
  };

  headerEl.addEventListener("pointerdown", (evt) => {
    isDragging = true;
    activePointerId = evt.pointerId;
    headerEl.setPointerCapture?.(activePointerId);
    const rect = windowEl.getBoundingClientRect();
    dragOffsetX = evt.clientX - rect.left;
    dragOffsetY = evt.clientY - rect.top;
    widthSnapshot = rect.width;
    heightSnapshot = rect.height;
    windowEl.style.left = `${rect.left}px`;
    windowEl.style.top = `${rect.top}px`;
    windowEl.style.right = "auto";
    windowEl.style.bottom = "auto";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    evt.preventDefault();
  });
}

function handleCommandResultMessage(payload) {
  if (!payload) {
    return;
  }

  let messageText = payload.toString();
  let level = "info";

  try {
    const data = JSON.parse(messageText);
    const summary = [];
    if (data.command) {
      summary.push(`命令: ${data.command}`);
    }
    if (typeof data.success === "boolean") {
      summary.push(data.success ? "执行成功" : "执行失败");
      level = data.success ? "success" : "error";
    }
    if (data.message) {
      summary.push(data.message);
    }

    const formattedJSON = JSON.stringify(data, null, 2);
    messageText = summary.length
      ? `${summary.join(" | ")}\n${formattedJSON}`
      : formattedJSON;
  } catch (error) {
    console.warn("解析命令结果失败", error);
  }

  appendConsoleLog(messageText, level);
}

function connectMQTTFromForm() {
  if (typeof mqtt === "undefined") {
    alert("MQTT 库尚未加载，请检查网络连接。");
    return;
  }

  const host = (elements.mqttHost?.value || "").trim();
  const topic = (elements.mqttTopic?.value || "").trim();
  const protocol = elements.protocolSelect?.value || "ws://";
  const port = (elements.mqttPort?.value || "").trim() || "8083";
  const path = (elements.mqttPath?.value || "").trim() || "/mqtt";
  const username = (elements.mqttUser?.value || "").trim();
  const password = elements.mqttPass?.value || "";
  const clientIdInput = (elements.mqttClientId?.value || "").trim();
  const controlTopicInput =
    (elements.mqttControlTopic?.value || DEFAULT_CONTROL_TOPIC).trim() ||
    DEFAULT_CONTROL_TOPIC;
  const resultTopicInput =
    (elements.mqttResultTopic?.value || DEFAULT_RESULT_TOPIC).trim() ||
    DEFAULT_RESULT_TOPIC;

        if (!host) {
    alert("请输入MQTT服务器地址");
            return;
        }

        if (!topic) {
    alert("请输入MQTT主题");
            return;
        }

  runtimeState.currentTopic = topic;
  runtimeState.controlTopic = controlTopicInput;
  runtimeState.commandResultTopic = resultTopicInput;

  const url = buildMqttUrl(protocol, host, port, path);
  const options = {
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10 * 1000,
    clientId: clientIdInput || `web_client_${Date.now()}`
  };

  if (username) {
    options.username = username;
    options.password = password;
  }

        if (mqttClient) {
    try {
      mqttClient.end(true);
    } catch (err) {
      console.warn("关闭旧MQTT连接失败", err);
    }
  }

  setMqttStatus("连接中...", "#faad14");
  setOfflineBanner(false);

        mqttClient = mqtt.connect(url, options);

  mqttClient.on("connect", () => {
    setMqttStatus("已连接", "#52c41a");
    const topics = [topic, runtimeState.commandResultTopic];
    topics.forEach((subTopic) => {
      mqttClient.subscribe(subTopic, (err) => {
        if (err) {
          console.warn("订阅主题失败", err);
          alert(`订阅主题失败: ${subTopic}`);
        }
      });
    });
  });

  mqttClient.on("message", (incomingTopic, payload) => {
    if (incomingTopic === runtimeState.commandResultTopic) {
      handleCommandResultMessage(payload);
      return;
    }

    try {
      const data = JSON.parse(payload.toString());
      handleIncomingPoint(data);
    } catch (error) {
      console.warn("解析MQTT消息失败", error);
    }
  });

  mqttClient.on("error", (error) => {
    console.warn("MQTT连接错误", error);
    setMqttStatus("连接错误", "#f5222d");
  });

  mqttClient.on("close", () => {
    setMqttStatus("已断开", "#999");
    setOfflineBanner(true);
  });
}

function disconnectMQTT() {
        if (mqttClient) {
    try {
            mqttClient.end(true);
    } catch (error) {
      console.warn("断开MQTT连接失败", error);
    }
            mqttClient = null;
  }
  setMqttStatus("已断开", "#999");
  setOfflineBanner(true);
}

function setMqttStatus(text, color) {
  if (elements.mqttStatus) {
    elements.mqttStatus.textContent = text;
    elements.mqttStatus.style.color = color;
  }
}

function buildMqttUrl(protocol, host, port, path) {
  if (host.startsWith("ws://") || host.startsWith("wss://")) {
    return host;
  }
  const sanitizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${protocol}${host}:${port}${sanitizedPath}`;
}

function addManualPoint() {
  const lng = parseFloat(elements.manualLng?.value || "");
  const lat = parseFloat(elements.manualLat?.value || "");
  const speed = parseFloat(elements.manualSpeed?.value || "0") || 0;

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    alert("请输入有效的经纬度数值");
        return;
    }
    
  const payload = {
    longitude: lng,
    latitude: lat,
    speed_ms: speed,
    timestamp: new Date().toISOString(),
    source: "manual_form"
  };

  handleIncomingPoint(payload);
  alert("已在地图上模拟一个轨迹点");
}

function exportTrackHistory() {
  if (!trackRecorder.history.length) {
    alert("暂无轨迹数据可导出");
        return;
    }
    
  const exportData = trackRecorder.history.map((point) => ({
    timestamp: point.timestamp,
    displayTime: point.displayTime,
    longitude: point.lng,
    latitude: point.lat,
    speed: point.speed,
    isInsideFence: point.isInsideFence,
    deviceId: point.deviceId,
    raw: point.raw
  }));

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `track_history_${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function ensureDate(value) {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    if (value > 1e12) {
      return new Date(value);
    }
    if (value > 1e10) {
      return new Date(value * 1000);
    }
    return new Date(value);
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
    const fallback = new Date(value.replace(/-/g, "/"));
    if (!Number.isNaN(fallback.getTime())) {
      return fallback;
    }
  }
  return new Date();
}

function formatDisplayTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function isPointInPolygon(point, polygonPoints) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygonPoints.length - 1; i < polygonPoints.length; j = i++) {
    const xi = polygonPoints[i][0];
    const yi = polygonPoints[i][1];
    const xj = polygonPoints[j][0];
    const yj = polygonPoints[j][1];
    const intersect =
      yi > y !== yj > y &&
      x <
        ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function gpsToGCJ(lng, lat) {
  const pi = 3.1415926535897932384626;
  const a = 6378245.0;
  const ee = 0.00669342162296594323;

  if (outOfChina(lng, lat)) {
    return [lng, lat];
  }

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * pi;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * pi);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * pi);
  const mgLat = lat + dLat;
  const mgLng = lng + dLng;
  return [mgLng, mgLat];
}

function outOfChina(lng, lat) {
  if (lng < 72.004 || lng > 137.8347) {
    return true;
  }
  if (lat < 0.8293 || lat > 55.8271) {
    return true;
  }
  return false;
}

function transformLat(x, y) {
  const pi = 3.1415926535897932384626;
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * pi) + 40.0 * Math.sin((y / 3.0) * pi)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * pi) + 320 * Math.sin((y * pi) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  const pi = 3.1415926535897932384626;
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * pi) + 40.0 * Math.sin((x / 3.0) * pi)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * pi) + 300.0 * Math.sin((x / 30.0) * pi)) * 2.0) / 3.0;
  return ret;
}

