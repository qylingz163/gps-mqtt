var map;
var tool;
var marker;
var jump_marker;
var markers = []; // 存储所有标记
var p_bhu_songshan = [121.119087, 41.086712]; //渤海大学松山校区
var p_bhu_binhai = [121.061722, 40.88588]; //渤海大学滨海校区

// 电子围栏相关变量
var fixedFencePolygon = null; // 固定围栏多边形
var customFencePolygon = null; // 自定义围栏多边形
var isDrawingFence = false; // 是否正在绘制围栏
var fencePoints = []; // 围栏顶点
var trackingMarker = null; // 跟踪标记
var trackingLine = null; // 跟踪轨迹线
var isTracking = false; // 是否正在跟踪
var trackPoints = []; // 轨迹点
var insideFence = false; // 是否在围栏内
var mqttClient = null; // MQTT客户端
var usingLiveFeed = false; // 是否使用真实MQTT数据
var subscribedTopic = 'student/location'; // 当前订阅的主题
var trackingInfoWindow = null; // 跟踪标记的信息窗口

// 离线检测相关
var lastMessageAt = 0; // 最近一次接收位置数据的时间戳（ms）
var isOffline = false; // 是否处于离线状态（基于数据静默）
var offlineThresholdMs = 15000; // 超过该时长未收到数据则视为离线
var offlineCheckTimer = null; // 定时检测句柄

// 回放相关变量
var replayTimer = null;
var replayIndex = 0;
var isReplaying = false;
var replayData = []; // 存储要回放的轨迹数据

// 渤海大学固定围栏坐标（围绕滨海校区，仅保留滨海校区围栏）
var bhuFencePoints = [
    [121.058244, 40.891822], // 左上角（用户提供）
    [121.058116, 40.882800], // 左下角（下移一点，扩大下面）
    [121.068500, 40.882800], // 右下角（右边左移一点）
    [121.068500, 40.891822]  // 右上角（右边左移一点）
];

// 所有围栏配置（只保留滨海校区）
var allFences = [
    {name: '渤海大学滨海校区', points: bhuFencePoints, color: '#FF33FF'}
];

// 自由绘制围栏相关变量
var isFreeDrawing = false;
var freeDrawPolyline = null;
var freeDrawPoints = [];
var freeDrawStartTime = 0;

// 历史记录数组
var historyPositions = [];

// 历史轨迹数据存储（带时间戳的完整轨迹点）
var historyTrackData = []; // 存储格式: {timestamp, position: [lng, lat], deviceId, ...}
var currentDeviceId = 'default'; // 当前设备ID

window.onload = function() {
    map = new AMap.Map("container", {
        resizeEnable: true,
        zoom: 15,
        center: p_bhu_binhai, // 地图中心点：滨海校区
    });

    //增加ToolBar插件
    AMap.plugin(["AMap.ToolBar"],function(){
        tool = new AMap.ToolBar();
        map.addControl(tool);
    });

    //增加Scale插件
    AMap.plugin(["AMap.Scale"],function(){
        var scale = new AMap.Scale();
        map.addControl(scale);
    });

    //增加Marker标记
    marker = new AMap.Marker({
        position: p_bhu_binhai,
        icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_bs.png',
        map: map,
        title: '当前位置'
    });

    //绑定地图移动事件
    map.on("moveend", logMapInfo);

    //增加jumpMarker标记
    jump_marker = new AMap.Marker({
        position: p_bhu_binhai,
        icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
        map: map,
        title: '目标位置'
    });

    // 添加鼠标事件监听
    map.on('mousedown', function(e) {
        // 如果正在自由绘制围栏
        if (isFreeDrawing) {
            startFreeDrawing(e.lnglat);
            return;
        }
    });
    
    map.on('mousemove', function(e) {
        // 如果正在自由绘制围栏
        if (isFreeDrawing && freeDrawPolyline) {
            continueFreeDrawing(e.lnglat);
        }
    });
    
    map.on('mouseup', function(e) {
        // 如果正在自由绘制围栏
        if (isFreeDrawing) {
            finishFreeDrawing(e.lnglat);
        }
    });

    // 添加键盘事件监听，按ESC键结束绘制
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && isFreeDrawing) {
            cancelFreeDrawing();
        }
    });

    // 初始化历史记录显示
    updateHistoryList();
    
    // 绘制所有固定围栏
    drawAllFixedFences();
    
    // 视野适配到围栏范围
    if (fixedFencePolygon) {
        map.setFitView([fixedFencePolygon]);
    }
    
    // 等待MQTT库和页面完全加载后自动连接
    // 由于使用了defer，需要等待脚本加载完成
    function tryAutoConnect() {
        if (typeof mqtt !== 'undefined') {
            // MQTT库已加载，延迟1秒后连接（确保页面完全加载）
            console.log('MQTT库已加载，准备自动连接...');
            setTimeout(function() {
                console.log('开始自动连接MQTT...');
                autoConnectMQTT();
            }, 1500);
        } else {
            // 等待MQTT库加载，每200ms检查一次
            console.log('等待MQTT库加载...');
            setTimeout(tryAutoConnect, 200);
        }
    }
    
    // 开始尝试连接（延迟500ms开始，确保DOM已加载）
    setTimeout(tryAutoConnect, 500);

    // 启动离线检测定时器（每秒检查一次）
    if (offlineCheckTimer) {
        clearInterval(offlineCheckTimer);
    }
    offlineCheckTimer = setInterval(function() {
        // 仅在使用真实数据场景判断离线；未接入或仅模拟时不提示
        if (!usingLiveFeed) return;
        if (!lastMessageAt) return;
        var now = Date.now();
        var silentMs = now - lastMessageAt;
        if (silentMs > offlineThresholdMs) {
            if (!isOffline) {
                setOfflineState(true);
            }
        } else {
            if (isOffline) {
                setOfflineState(false);
            }
        }
    }, 1000);
}

// 统一的消息提示（替代 alert）
function alertInfo(message) {
    try {
        if (typeof showNotification === 'function') {
            showNotification(message);
            return;
        }
    } catch (e) {}
    console.log(message);
}

// 设置离线/在线的页面显示与样式
function setOfflineState(offline) {
    isOffline = offline === true;
    // 顶部横幅
    var banner = document.getElementById('offline_banner');
    if (banner) {
        banner.style.display = isOffline ? 'block' : 'none';
    }
    // 标记与轨迹样式：离线时降低透明度，保持最后一次位置
    if (trackingMarker) {
        trackingMarker.setOpacity(isOffline ? 0.6 : 1.0);
    }
    if (trackingLine) {
        trackingLine.setOptions({
            strokeOpacity: isOffline ? 0.4 : 0.8
        });
    }
    // MQTT状态不改文案颜色，仅离线条提示基于数据静默
}

//根据文本框的输入，跳转到该经纬度位置，并设置标记。
function addMarker() {
    var lng = document.getElementById("position_lng").value;
    var lat = document.getElementById("position_lat").value;

    if (!lng || !lat) {
        alertInfo("请输入完整的经纬度信息！");
        return;
    }

    var position = [parseFloat(lng), parseFloat(lat)];

    // 保存到历史记录
    saveToHistory(position, "自定义位置");

    map.setCenter(position);
    jump_marker.setPosition(position);

    // 更新历史记录显示
    updateHistoryList();
}

//根据文本框的输入，跳转到该GPS经纬度位置，并设置标记。
function addMarkerGPS() {
    var lng = document.getElementById("position_lng_gps").value;
    var lat = document.getElementById("position_lat_gps").value;

    if (!lng || !lat) {
        alertInfo("请输入完整的GPS经纬度信息！");
        return;
    }

    // 验证坐标格式
    if (isNaN(parseFloat(lng)) || isNaN(parseFloat(lat))) {
        alertInfo("请输入有效的经纬度数值！");
        return;
    }

    var position = [parseFloat(lng), parseFloat(lat)];

    console.log('开始转换GPS坐标:', position);

    // 首先尝试使用高德地图在线转换
    if (typeof AMap !== 'undefined' && AMap.convertFrom) {
        //需要将坐标转换为GCJ-02坐标系
        AMap.convertFrom(position, 'gps', function(status, result){
            console.log('坐标转换结果:', status, result);

            if(status === "complete" && result && result.info === 'ok' && result.locations && result.locations.length > 0){
                var destPosition = result.locations[0];
                console.log('转换后的坐标：', destPosition);

                // 保存到历史记录
                saveToHistory([destPosition.lng, destPosition.lat], "GPS位置");

                map.setCenter(destPosition);
                jump_marker.setPosition(destPosition);

                // 更新历史记录显示
                updateHistoryList();

                alertInfo('GPS坐标跳转成功！');
            } else {
                // 在线转换失败，尝试离线转换
                console.log('在线转换失败，尝试离线转换');
                var convertedPosition = gpsToGCJ(position[0], position[1]);

                // 保存到历史记录
                saveToHistory(convertedPosition, "GPS位置(离线)");

                map.setCenter(convertedPosition);
                jump_marker.setPosition(convertedPosition);

                // 更新历史记录显示
                updateHistoryList();

                alertInfo('GPS坐标转换成功（使用离线算法）！');
            }
        });
    } else {
        // 高德地图API不可用，直接使用离线转换
        console.log('高德地图API不可用，使用离线转换');
        var convertedPosition = gpsToGCJ(position[0], position[1]);

        // 保存到历史记录
        saveToHistory(convertedPosition, "GPS位置(离线)");

        map.setCenter(convertedPosition);
        jump_marker.setPosition(convertedPosition);

        // 更新历史记录显示
        updateHistoryList();

        alertInfo('GPS坐标转换成功（使用离线算法）！');
    }
}

//"渤大"按钮，跳转到渤海大学滨海校区
function addMarker2() {
    document.getElementById("position_lng").value = p_bhu_binhai[0];
    document.getElementById("position_lat").value = p_bhu_binhai[1];
    addMarker();
    map.setZoom(14);
}

//显示地图层级与中心点信息
function logMapInfo(){
    var center = map.getCenter();
    var position = [center.lng, center.lat];
    marker.setPosition(position);
    document.getElementById("position_lng").value = position[0];
    document.getElementById("position_lat").value = position[1];
}

// 添加自定义标记
function addCustomMarker(lnglat) {
    // 如果正在自由绘制围栏，则不添加自定义标记
    if (isFreeDrawing) {
        return;
    }
    
    var marker = new AMap.Marker({
        position: lnglat,
        map: map,
        draggable: true,
        title: '自定义标记'
    });

    // 添加信息窗口
    var infoWindow = new AMap.InfoWindow({
        content: '<div class="info-window">' +
                 '<h3>自定义标记</h3>' +
                 '<p>经度: ' + lnglat.lng + '</p>' +
                 '<p>纬度: ' + lnglat.lat + '</p>' +
                 '<button onclick="removeMarker(this)">删除</button>' +
                 '</div>',
        offset: new AMap.Pixel(0, -30)
    });

    // 点击标记显示信息窗口
    marker.on('click', function() {
        infoWindow.open(map, marker.getPosition());
    });

    // 保存标记引用
    markers.push({
        marker: marker,
        infoWindow: infoWindow
    });

    // 保存到历史记录
    saveToHistory([lnglat.lng, lnglat.lat], "地图右键添加");
    updateHistoryList();
}

// 删除标记
function removeMarker(buttonElement) {
    // 这里简化处理，实际项目中可能需要更复杂的逻辑
    alert("标记已删除");
}

// 保存到历史记录
function saveToHistory(position, name) {
    var record = {
        name: name,
        lng: position[0],
        lat: position[1],
        time: new Date().toLocaleString()
    };

    historyPositions.unshift(record); // 添加到开头

    // 限制历史记录数量
    if (historyPositions.length > 10) {
        historyPositions.pop();
    }

    // 保存到localStorage
    localStorage.setItem('mapHistory', JSON.stringify(historyPositions));
}

// 更新历史记录显示
function updateHistoryList() {
    // 如果有历史记录，则从localStorage加载
    var stored = localStorage.getItem('mapHistory');
    if (stored) {
        historyPositions = JSON.parse(stored);
    }

    // 这里可以更新页面上的历史记录列表（如果有的话）
    console.log("历史记录:", historyPositions);
}

// 后端API地址配置
var API_BASE_URL = window.location.origin + '/api';

// 保存轨迹点到历史数据（发送到后端API，不再使用localStorage）
function saveTrackPointToHistory(trackPoint) {
    // 添加到内存数组（用于实时显示）
    historyTrackData.push(trackPoint);
    
    // 限制内存中的数据量（保留最近1000条，仅用于实时显示）
    if (historyTrackData.length > 1000) {
        historyTrackData.shift();
    }
    
    // 发送到后端API存储（异步，不阻塞）
    // 注意：后端服务会通过MQTT订阅自动保存，这里作为备用
    // 如果后端服务正常运行，可以注释掉下面的代码
    /*
    fetch(API_BASE_URL + '/tracks', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            device_id: trackPoint.deviceId,
            timestamp: trackPoint.timestamp,
            longitude: trackPoint.longitude || trackPoint.position[0],
            latitude: trackPoint.latitude || trackPoint.position[1],
            altitude: trackPoint.altitude || 0,
            time: trackPoint.time,
            source: 'Web-Client'
        })
    }).catch(function(error) {
        console.log('保存轨迹数据到后端失败:', error);
    });
    */
}

// 从后端API加载历史轨迹数据
function loadHistoryTrackData(deviceId, startTime, endTime, callback) {
    // 构建API请求URL
    var url = API_BASE_URL + '/tracks?';
    if (deviceId && deviceId !== 'all') {
        url += 'device_id=' + encodeURIComponent(deviceId) + '&';
    }
    if (startTime) {
        // 将Date对象转换为Unix时间戳（秒）
        var startTimestamp = Math.floor(new Date(startTime).getTime() / 1000);
        url += 'start_time=' + startTimestamp + '&';
    }
    if (endTime) {
        // 将Date对象转换为Unix时间戳（秒）
        var endTimestamp = Math.floor(new Date(endTime).getTime() / 1000);
        url += 'end_time=' + endTimestamp + '&';
    }
    url += 'limit=10000';
    
    // 从后端API获取数据
    fetch(url)
        .then(function(response) {
            return response.json();
        })
        .then(function(result) {
            if (result.status === 'ok' && result.data) {
                // 转换数据格式，添加position字段
                var trackData = result.data.map(function(point) {
                    return {
                        timestamp: point.timestamp,
                        position: point.position || [point.longitude, point.latitude],
                        deviceId: point.deviceId || point.device_id,
                        time: point.time,
                        longitude: point.longitude,
                        latitude: point.latitude,
                        altitude: point.altitude || 0
                        // 注意：不包含speed和course字段，围栏状态在回放时实时计算
                    };
                });
                
                // 调用回调函数返回数据
                if (callback) {
                    callback(trackData);
                } else {
                    return trackData;
                }
            } else {
                console.log('获取历史轨迹数据失败:', result);
                if (callback) {
                    callback([]);
                } else {
                    return [];
                }
            }
        })
        .catch(function(error) {
            console.log('加载历史轨迹数据失败:', error);
            alertInfo('加载历史轨迹数据失败，请检查后端服务是否正常运行');
            if (callback) {
                callback([]);
            } else {
                return [];
            }
        });
}

// 从后端API获取所有可用的设备ID列表
function getAvailableDeviceIds(callback) {
    fetch(API_BASE_URL + '/devices')
        .then(function(response) {
            return response.json();
        })
        .then(function(result) {
            if (result.status === 'ok' && result.data) {
                var deviceIds = result.data;
                if (callback) {
                    callback(deviceIds);
                } else {
                    return deviceIds;
                }
            } else {
                console.log('获取设备列表失败:', result);
                if (callback) {
                    callback([]);
                } else {
                    return [];
                }
            }
        })
        .catch(function(error) {
            console.log('获取设备列表失败:', error);
            if (callback) {
                callback([]);
            } else {
                return [];
            }
        });
}

// 清除所有自定义标记
function clearMarkers() {
    for (var i = 0; i < markers.length; i++) {
        markers[i].marker.setMap(null);
    }
    markers = [];
    alertInfo("所有自定义标记已清除");
}

// GPS坐标转GCJ-02坐标系的离线转换算法
function gpsToGCJ(lng, lat) {
    var pi = 3.1415926535897932384626;
    var a = 6378245.0;
    var ee = 0.00669342162296594323;

    if (outOfChina(lng, lat)) {
        return [lng, lat];
    }

    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * pi;
    var magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * pi);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * pi);
    var mgLat = lat + dLat;
    var mgLng = lng + dLng;

    return [mgLng, mgLat];
}

// 判断坐标是否在中国境外
function outOfChina(lng, lat) {
    if (lng < 72.004 || lng > 137.8347) {
        return true;
    }
    if (lat < 0.8293 || lat > 55.8271) {
        return true;
    }
    return false;
}

// 纬度转换
function transformLat(x, y) {
    var pi = 3.1415926535897932384626;
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * pi) + 40.0 * Math.sin(y / 3.0 * pi)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * pi) + 320 * Math.sin(y * pi / 30.0)) * 2.0 / 3.0;
    return ret;
}

// 经度转换
function transformLng(x, y) {
    var pi = 3.1415926535897932384626;
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * pi) + 20.0 * Math.sin(2.0 * x * pi)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * pi) + 40.0 * Math.sin(x / 3.0 * pi)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * pi) + 300.0 * Math.sin(x / 30.0 * pi)) * 2.0 / 3.0;
    return ret;
}

// 切换地图类型
function switchMapType(type) {
    switch(type) {
        case 'normal':
            map.setLayers([new AMap.TileLayer()]);
            break;
        case 'satellite':
            map.setLayers([new AMap.TileLayer.Satellite()]);
            break;
        case 'road':
            map.setLayers([new AMap.TileLayer.RoadNet()]);
            break;
    }
}

// ========== 电子围栏相关功能 ==========

// 绘制渤海大学固定围栏
function drawFixedFence() {
    // 清除之前的固定围栏
    if (fixedFencePolygon) {
        fixedFencePolygon.setMap(null);
    }
    
    // 创建固定围栏多边形
    fixedFencePolygon = new AMap.Polygon({
        path: bhuFencePoints,
        strokeColor: "#FF33FF",
        strokeWeight: 3,
        strokeOpacity: 0.8,
        fillOpacity: 0.2,
        fillColor: '#1791fc',
        zIndex: 50,
    });
    
    fixedFencePolygon.setMap(map);
    
    // 在围栏顶点添加标记
    for (var i = 0; i < bhuFencePoints.length; i++) {
        var fencePointMarker = new AMap.Marker({
            position: bhuFencePoints[i],
            map: map,
            icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_b.png',
            title: '渤海大学围栏点'
        });
        
        markers.push({
            marker: fencePointMarker,
            type: 'fixedFencePoint'
        });
    }
    
    console.log("固定围栏绘制完成");
}

// 绘制所有固定围栏
function drawAllFixedFences() {
    // 清除之前的固定围栏标记
    for (var i = markers.length - 1; i >= 0; i--) {
        if (markers[i].type === 'fixedFence' || markers[i].type === 'fixedFencePoint') {
            markers[i].marker.setMap(null);
            markers.splice(i, 1);
        }
    }
    
    if (fixedFencePolygon) {
        fixedFencePolygon.setMap(null);
    }
    
    // 绘制所有围栏（仅滨海校区）
    allFences.forEach(function(fence, index) {
        // 创建围栏多边形
        var polygon = new AMap.Polygon({
            path: fence.points,
            strokeColor: fence.color,
            strokeWeight: 3,
            strokeOpacity: 0.8,
            fillOpacity: 0.2,
            fillColor: fence.color,
            zIndex: 50,
        });
        
        polygon.setMap(map);
        
        // 添加围栏标签
        var center = getPolygonCenter(fence.points);
        var label = new AMap.Text({
            text: fence.name,
            position: center,
            offset: new AMap.Pixel(0, 0),
            style: {
                'background-color': 'rgba(255,255,255,0.9)',
                'border': '1px solid ' + fence.color,
                'padding': '3px 8px',
                'font-size': '13px',
                'color': '#333',
                'font-weight': 'bold'
            }
        });
        label.setMap(map);
        
        // 保存围栏引用
        if (index === 0) {
            fixedFencePolygon = polygon; // 保留第一个作为主围栏引用
        }
        
        markers.push({
            marker: polygon,
            type: 'fixedFence',
            name: fence.name
        });
        
        markers.push({
            marker: label,
            type: 'fixedFence',
            name: fence.name + '_label'
        });
    });
    
    console.log("所有固定围栏绘制完成，共 " + allFences.length + " 个围栏");
}

// 计算多边形中心点
function getPolygonCenter(points) {
    var sumLng = 0, sumLat = 0;
    for (var i = 0; i < points.length; i++) {
        sumLng += points[i][0];
        sumLat += points[i][1];
    }
    return [sumLng / points.length, sumLat / points.length];
}

// 开始绘制围栏（自由绘制）
function startFenceDrawing() {
    // 禁用自由绘制：围栏已固定为滨海校区
    alertInfo("围栏已固定为『渤海大学滨海校区』，不可自定义绘制。");
    return;
}

// 开始自由绘制
function startFreeDrawing(lnglat) {
    freeDrawPoints.push([lnglat.lng, lnglat.lat]);
    
    // 创建绘制线
    freeDrawPolyline = new AMap.Polyline({
        path: freeDrawPoints,
        strokeColor: "#00FF00",
        strokeWeight: 3,
        strokeOpacity: 0.8,
        zIndex: 50,
    });
    
    freeDrawPolyline.setMap(map);
}

// 继续自由绘制
function continueFreeDrawing(lnglat) {
    if (!freeDrawPolyline) return;
    
    freeDrawPoints.push([lnglat.lng, lnglat.lat]);
    
    // 更新绘制线
    freeDrawPolyline.setPath(freeDrawPoints);
}

// 完成自由绘制
function finishFreeDrawing() {
    // 如果没有足够的点，则取消绘制
    if (!freeDrawPolyline || freeDrawPoints.length < 3) {
        cancelFreeDrawing();
        return;
    }
    
    // 创建围栏多边形（连接起点和终点）
    var polygonPoints = freeDrawPoints.slice(); // 复制数组
    polygonPoints.push(freeDrawPoints[0]); // 连接起点和终点
    
    // 清除绘制线
    freeDrawPolyline.setMap(null);
    
    // 创建围栏多边形
    customFencePolygon = new AMap.Polygon({
        path: polygonPoints,
        strokeColor: "#00FF00",
        strokeWeight: 3,
        strokeOpacity: 0.8,
        fillOpacity: 0.2,
        fillColor: '#00FF00',
        zIndex: 50,
    });
    
    customFencePolygon.setMap(map);
    
    // 保存自定义围栏引用
    markers.push({
        marker: customFencePolygon,
        type: 'customFence'
    });
    
    // 退出绘制模式
    isFreeDrawing = false;
    freeDrawPolyline = null;
    
    // 恢复按钮样式
    var drawButton = document.querySelector('button[onclick="startFenceDrawing()"]');
    if (drawButton) {
        drawButton.style.backgroundColor = "#4CAF50";
        drawButton.textContent = "绘制围栏";
    }
    
    alertInfo("自由绘制围栏完成！");
}

// 取消自由绘制
function cancelFreeDrawing() {
    // 清除绘制线
    if (freeDrawPolyline) {
        freeDrawPolyline.setMap(null);
        freeDrawPolyline = null;
    }
    
    // 重置绘制状态
    isFreeDrawing = false;
    freeDrawPoints = [];
    
    // 恢复按钮样式
    var drawButton = document.querySelector('button[onclick="startFenceDrawing()"]');
    if (drawButton) {
        drawButton.style.backgroundColor = "#4CAF50";
        drawButton.textContent = "绘制围栏";
    }
    
    alertInfo("已取消绘制");
}

// 清除临时绘制元素
function clearTempDrawing() {
    // 清除临时圆形和圆心标记
    for (var i = markers.length - 1; i >= 0; i--) {
        if (markers[i].type === 'tempCircle' || markers[i].type === 'circleCenter') {
            markers[i].marker.setMap(null);
            markers.splice(i, 1);
        }
    }
    
    if (tempCircle) {
        tempCircle.setMap(null);
        tempCircle = null;
    }
    
    if (circleMarker) {
        circleMarker.setMap(null);
        circleMarker = null;
    }
}

// 清除自定义围栏（保留固定围栏）
function clearCustomFence() {
    // 清除自定义围栏和围栏点标记
    for (var i = markers.length - 1; i >= 0; i--) {
        if (markers[i].type === 'fencePoint' || markers[i].type === 'customFence' || 
            markers[i].type === 'customFenceCircle' || markers[i].type === 'tempCircle' || 
            markers[i].type === 'circleCenter') {
            markers[i].marker.setMap(null);
            markers.splice(i, 1);
        }
    }
    
    // 清除自定义围栏多边形
    if (customFencePolygon) {
        customFencePolygon.setMap(null);
        customFencePolygon = null;
    }
    
    // 清除自定义围栏圆形
    if (customFenceCircle) {
        customFenceCircle.setMap(null);
        customFenceCircle = null;
    }
    
    // 清除自由绘制相关
    if (freeDrawPolyline) {
        freeDrawPolyline.setMap(null);
        freeDrawPolyline = null;
    }
    
    fencePoints = [];
    isDrawingFence = false;
    isFreeDrawing = false;
    freeDrawPoints = [];
    
    // 恢复按钮样式
    var drawButton = document.querySelector('button[onclick="startFenceDrawing()"]');
    if (drawButton) {
        drawButton.style.backgroundColor = "#4CAF50";
        drawButton.textContent = "绘制围栏";
    }
}

// 清除所有围栏
function clearFence() {
    // 仅清除自定义围栏，固定围栏保持
    clearCustomFence();
    // 确保固定围栏存在
    if (!fixedFencePolygon) {
        drawAllFixedFences();
    }
    alertInfo("已清除自定义围栏。系统固定围栏保持为『渤海大学滨海校区』。");
}

// 射线法判断点是否在多边形内
function isPointInPolygon(point, polygonPoints) {
    var x = point[0], y = point[1];
    var inside = false;
    
    for (var i = 0, j = polygonPoints.length - 1; i < polygonPoints.length; j = i++) {
        var xi = polygonPoints[i][0], yi = polygonPoints[i][1];
        var xj = polygonPoints[j][0], yj = polygonPoints[j][1];
        
        var intersect = ((yi > y) != (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    
    return inside;
}

// ========== 实时跟踪相关功能 ==========

// 开始跟踪
function startTracking() {
    if (isTracking) {
        alertInfo("已经在跟踪模式中！");
        return;
    }
    
    isTracking = true;
    trackPoints = [];
    
    // 创建跟踪标记
    if (!trackingMarker) {
        trackingMarker = new AMap.Marker({
            position: p_bhu_binhai,
            icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
            map: map,
            title: '跟踪目标'
        });
    }
    
    // 创建轨迹线
    if (!trackingLine) {
        trackingLine = new AMap.Polyline({
            path: trackPoints,
            strokeColor: "#3366FF",
            strokeWeight: 3,
            strokeOpacity: 0.8,
            zIndex: 60,
        });
        trackingLine.setMap(map);
    }
    
    // 开始模拟跟踪
    simulateTracking();
    
    alertInfo("开始跟踪目标位置");
}

// 停止跟踪
function stopTracking() {
    isTracking = false;
    insideFence = false;
    alertInfo("已停止跟踪");
}

// 模拟跟踪（实际项目中应从GPS设备获取位置）
function simulateTracking() {
    if (!isTracking) return;
    if (usingLiveFeed) return; // 有真实数据时不再模拟
    
    // 模拟位置变化（在渤海大学滨海校区附近移动）
    var center = p_bhu_binhai;
    var offset = [
        (Math.random() - 0.5) * 0.01,
        (Math.random() - 0.5) * 0.01
    ];
    var newPosition = [center[0] + offset[0], center[1] + offset[1]];
    
    console.log("模拟位置更新:", newPosition);
    
    // 更新跟踪标记位置
    trackingMarker.setPosition(newPosition);
    
    // 添加到轨迹点
    trackPoints.push(newPosition);
    
    // 更新轨迹线
    if (trackingLine) {
        trackingLine.setPath(trackPoints);
    }
    
    // 检查是否进入/离开围栏
    checkFenceCrossing(newPosition);
    
    // 发布MQTT消息
    publishLocation(newPosition);
    
    // 每2秒更新一次位置
    setTimeout(simulateTracking, 2000);
}

// 检查是否进入/离开围栏
function checkFenceCrossing(position) {
    // 检查是否在任一固定围栏内
    var insideAnyFence = false;
    var currentFenceName = '';
    
    // 检查所有固定围栏
    for (var i = 0; i < allFences.length; i++) {
        if (isPointInPolygon(position, allFences[i].points)) {
            insideAnyFence = true;
            currentFenceName = allFences[i].name;
            break;
        }
    }
    
    // 检查是否在自定义围栏内
    var insideCustomFence = false;
    if (customFencePolygon) {
        var path = customFencePolygon.getPath();
        if (path && path.length >= 3) {
            insideCustomFence = isPointInPolygon(position, path.map(function(point) {
                return [point.lng, point.lat];
            }));
        }
    }
    
    // 如果在任一围栏内，则认为在围栏内
    var inside = insideAnyFence || insideCustomFence;
    
    console.log("位置检查:", position, "在围栏内:", inside, "围栏名称:", currentFenceName, "当前状态:", insideFence);
    
    // 状态发生变化时触发告警
    if (inside && !insideFence) {
        // 进入围栏
        insideFence = true;
        var fenceName = currentFenceName || '电子围栏';
        var alertMsg = "⚠️ 告警：目标进入" + fenceName + "区域！位置: [" + position[0].toFixed(6) + ", " + position[1].toFixed(6) + "]";
        alertInfo(alertMsg);
        console.log(alertMsg);
        
        // 改变轨迹颜色为红色（在围栏内）
        if (trackingLine) {
            trackingLine.setOptions({
                strokeColor: "#FF0000"
            });
        }
        
        // 改变标记颜色为红色
        if (trackingMarker) {
            trackingMarker.setIcon('https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png');
        }
    } else if (!inside && insideFence) {
        // 离开围栏
        insideFence = false;
        var alertMsg = "⚠️ 告警：目标离开电子围栏区域！位置: [" + position[0].toFixed(6) + ", " + position[1].toFixed(6) + "]";
        alertInfo(alertMsg);
        console.log(alertMsg);
        
        // 恢复轨迹颜色为蓝色（在围栏外）
        if (trackingLine) {
            trackingLine.setOptions({
                strokeColor: "#3366FF"
            });
        }
        
        // 恢复标记颜色
        if (trackingMarker) {
            trackingMarker.setIcon('https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png');
        }
    } else if (!inside && !insideFence) {
        // 在围栏外，但状态未变化（首次检查或一直在围栏外）
        // 确保轨迹颜色为蓝色
        if (trackingLine) {
            trackingLine.setOptions({
                strokeColor: "#3366FF"
            });
        }
        console.log("目标在围栏外，位置: [" + position[0].toFixed(6) + ", " + position[1].toFixed(6) + "]");
    }
    
    // 返回当前是否在围栏内（用于轨迹颜色判断）
    return inside;
}

// 更新信息窗口内容
function updateInfoWindowContent(deviceId, lng, lat, data) {
    if (!trackingInfoWindow) return;
    
    var content = '<div style="padding: 10px; min-width: 200px;">' +
                  '<h4 style="margin: 0 0 8px 0; color: #333;">📍 实时位置信息</h4>' +
                  '<p style="margin: 4px 0; font-size: 13px;"><strong>设备ID:</strong> <span style="color: #2196F3;">' + deviceId + '</span></p>' +
                  '<p style="margin: 4px 0; font-size: 13px;"><strong>经度:</strong> ' + lng.toFixed(6) + '</p>' +
                  '<p style="margin: 4px 0; font-size: 13px;"><strong>纬度:</strong> ' + lat.toFixed(6) + '</p>' +
                  '<p style="margin: 4px 0; font-size: 13px;"><strong>时间:</strong> ' + (data.time || new Date().toLocaleString('zh-CN')) + '</p>';
    
    // 显示围栏状态
    var fenceStatus = insideFence ? '<span style="color: #FF0000;">⚠️ 在围栏内</span>' : '<span style="color: #4CAF50;">✓ 在围栏外</span>';
    content += '<p style="margin: 4px 0; font-size: 13px;"><strong>围栏状态:</strong> ' + fenceStatus + '</p>';
    
    content += '</div>';
    
    trackingInfoWindow.setContent(content);
}

// 显示通知
function showNotification(message) {
    // 创建通知元素
    var notification = document.createElement('div');
    notification.innerHTML = message;
    notification.style.position = 'fixed';
    notification.style.top = '50px';
    notification.style.right = '10px';
    notification.style.backgroundColor = '#ff4444';
    notification.style.color = 'white';
    notification.style.padding = '10px';
    notification.style.borderRadius = '5px';
    notification.style.zIndex = '1000';
    notification.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
    
    document.body.appendChild(notification);
    
    // 3秒后自动移除
    setTimeout(function() {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 3000);
}

// ========== MQTT相关功能 ==========

// 自动连接MQTT（使用预设配置）
function autoConnectMQTT() {
    // 预设的MQTT连接信息
    var host = '123.206.123.20';
    var port = '8083';
    var topic = 'student/location';
    var username = 'wzg';
    var password = '123456';
    
    console.log('开始自动连接MQTT...', host, port, username);
    
    // 更新连接状态显示
    var statusEl = document.getElementById('mqtt_status');
    if (statusEl) {
        statusEl.textContent = '连接中...';
        statusEl.style.color = '#FF9800';
    }
    
    connectMQTT(host, port, topic, username, password);
}

// 初始化MQTT连接
function initMQTT() {
    // 兼容旧入口：若页面已填主机则按表单连接，否则不做任何事
    var hostInput = document.getElementById('mqtt_host');
    if (hostInput && hostInput.value.trim()) {
        connectMQTTFromForm();
    }
}

function connectMQTTFromForm() {
    try {
        var host = (document.getElementById('mqtt_host') || { value: '' }).value.trim();
        var port = (document.getElementById('mqtt_port') || { value: '' }).value.trim();
        var topic = (document.getElementById('mqtt_topic') || { value: 'student/location' }).value.trim();
        var username = (document.getElementById('mqtt_user') || { value: '' }).value.trim();
        var password = (document.getElementById('mqtt_pass') || { value: '' }).value.trim();

        if (!host) {
            // 如果没有输入，使用预设配置
            autoConnectMQTT();
            return;
        }

        if (!topic) {
            alertInfo('请输入MQTT主题名称');
            return;
        }

        // 调用统一的连接函数
        connectMQTT(host, port, topic, username, password);
    } catch (e) {
        console.log('MQTT连接失败:', e);
        alertInfo('MQTT连接失败');
    }
}

// 统一的MQTT连接函数
function connectMQTT(host, port, topic, username, password) {
    try {
        // 保存当前订阅的主题
        subscribedTopic = topic || 'student/location';

        var url = host;
        // 如果输入的不是完整URL（ws://或wss://开头），则自动构建URL
        if (!(host.startsWith('ws://') || host.startsWith('wss://'))) {
            var p = port || '8083'; // 默认使用8083（HTTP WebSocket）
            var protocol = 'ws://'; // 默认使用ws://（HTTP），IP地址通常使用HTTP
            
            // 如果端口是8084或8443，使用wss://（HTTPS WebSocket）
            if (p === '8084' || p === '8443') {
                protocol = 'wss://';
            }
            
            // 构建完整URL：协议 + 主机/IP + 端口 + /mqtt
            url = protocol + host + ':' + p + '/mqtt';
        }

        var options = {};
        if (username) options.username = username;
        if (password) options.password = password;

        if (mqttClient) {
            try { mqttClient.end(true); } catch (e) {}
        }

        console.log('正在连接MQTT:', url, '用户名:', username);
        mqttClient = mqtt.connect(url, options);

        mqttClient.on('connect', function () {
            console.log('MQTT连接成功:', url);
            alertInfo('MQTT连接成功');
            
            // 更新连接状态显示
            var statusEl = document.getElementById('mqtt_status');
            if (statusEl) {
                statusEl.textContent = '已连接';
                statusEl.style.color = '#4CAF50';
            }
            
            // 订阅用户指定的主题
            mqttClient.subscribe(subscribedTopic, function (err) {
                if (!err) {
                    console.log('已订阅主题:', subscribedTopic);
                    alertInfo('已订阅主题: ' + subscribedTopic);
                } else {
                    console.log('订阅失败:', err);
                    alertInfo('订阅主题失败: ' + subscribedTopic);
                }
            });
        });

        mqttClient.on('message', function (topic, payload) {
            // 只处理订阅的主题消息
            if (topic !== subscribedTopic) {
                console.log('收到其他主题消息:', topic, '期望主题:', subscribedTopic);
                return;
            }
            try {
                var data = JSON.parse(payload.toString());
                var lng = Number(data.longitude);
                var lat = Number(data.latitude);
                if (!isFinite(lng) || !isFinite(lat)) return;

                usingLiveFeed = true;
                var newPosition = [lng, lat];
                // 刷新最近消息时间戳并清除离线状态
                lastMessageAt = Date.now();
                if (isOffline) {
                    setOfflineState(false);
                }
                
                // 回放中时，不更新实时渲染，避免与回放冲突
                if (isReplaying) {
                    return;
                }
                
                // 获取设备ID（如果有）
                var deviceId = data.device_id || data.deviceId || currentDeviceId;
                currentDeviceId = deviceId;

                // 创建带时间戳的轨迹点数据（不包含speed和course字段）
                var trackPoint = {
                    timestamp: data.timestamp || Math.floor(Date.now() / 1000),
                    position: newPosition,
                    deviceId: deviceId,
                    time: data.time || new Date().toLocaleString('zh-CN'),
                    longitude: lng,
                    latitude: lat,
                    altitude: data.altitude || 0
                };

                // 保存到历史轨迹数据（发送到后端API）
                saveTrackPointToHistory(trackPoint);

                // 更新/创建跟踪标记
                if (!trackingMarker) {
                    trackingMarker = new AMap.Marker({
                        position: newPosition,
                        icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
                        map: map,
                        title: '实时目标 - ' + deviceId,
                        animation: 'AMAP_ANIMATION_DROP' // 添加动画效果
                    });
                    
                    // 创建信息窗口显示详细信息
                    trackingInfoWindow = new AMap.InfoWindow({
                        content: '',
                        offset: new AMap.Pixel(0, -30),
                        closeWhenClickMap: false // 点击地图不关闭
                    });
                    
                    // 点击标记显示信息窗口
                    trackingMarker.on('click', function() {
                        updateInfoWindowContent(deviceId, lng, lat, data);
                        trackingInfoWindow.open(map, trackingMarker.getPosition());
                    });
                    
                    // 首次显示时自动打开信息窗口
                    setTimeout(function() {
                        updateInfoWindowContent(deviceId, lng, lat, data);
                        trackingInfoWindow.open(map, newPosition);
                    }, 500);
                    
                    // 将地图中心移动到当前位置
                    map.setCenter(newPosition);
                    map.setZoom(15); // 设置合适的缩放级别
                } else {
                    trackingMarker.setPosition(newPosition);
                    trackingMarker.setTitle('实时目标 - ' + deviceId);
                    
                    // 如果信息窗口已打开，实时更新内容
                    if (trackingInfoWindow && trackingInfoWindow.getIsOpen()) {
                        updateInfoWindowContent(deviceId, lng, lat, data);
                        trackingInfoWindow.setPosition(newPosition);
                    }
                    
                    // 实时更新时，可选：自动调整地图视野跟随标记（注释掉，避免地图频繁跳动）
                    // map.setCenter(newPosition);
                }

                // 围栏判定（在绘制轨迹之前，用于确定颜色）
                var isInsideFence = checkFenceCrossing(newPosition);
                
                // 仅在“跟踪模式”下累计轨迹并绘制折线；查看模式只更新当前位置，不画线
                if (isTracking) {
                    trackPoints.push(newPosition);
                    if (!trackingLine) {
                        // 根据围栏状态设置初始颜色
                        var lineColor = isInsideFence ? '#FF0000' : '#3366FF';
                        trackingLine = new AMap.Polyline({
                            path: trackPoints,
                            strokeColor: lineColor,
                            strokeWeight: 3,
                            strokeOpacity: 0.8,
                            zIndex: 60,
                        });
                        trackingLine.setMap(map);
                    } else {
                        // 更新轨迹路径
                        var currentPath = trackingLine.getPath();
                        currentPath.push(newPosition);
                        trackingLine.setPath(currentPath);
                        
                        // 根据当前位置是否在围栏内更新颜色
                        var lineColor = isInsideFence ? '#FF0000' : '#3366FF';
                        trackingLine.setOptions({
                            strokeColor: lineColor
                        });
                    }
                }
            } catch (e) {
                console.log('解析MQTT消息失败:', e);
            }
        });

        mqttClient.on('error', function (error) {
            console.log('MQTT连接错误:', error);
            alertInfo('MQTT连接错误');
            
            // 更新连接状态显示
            var statusEl = document.getElementById('mqtt_status');
            if (statusEl) {
                statusEl.textContent = '连接失败';
                statusEl.style.color = '#f44336';
            }
        });
        
        mqttClient.on('close', function () {
            // 更新连接状态显示
            var statusEl = document.getElementById('mqtt_status');
            if (statusEl) {
                statusEl.textContent = '已断开';
                statusEl.style.color = '#999';
            }
        });
    } catch (e) {
        console.log('MQTT初始化失败:', e);
        alertInfo('MQTT初始化失败');
    }
}

function disconnectMQTT() {
    try {
        if (mqttClient) {
            mqttClient.end(true);
            mqttClient = null;
            alertInfo('MQTT已断开');
            
            // 更新连接状态显示
            var statusEl = document.getElementById('mqtt_status');
            if (statusEl) {
                statusEl.textContent = '已断开';
                statusEl.style.color = '#999';
            }
        }
    } catch (e) {
        console.log('断开MQTT失败:', e);
    }
}

// 发布位置信息
function publishLocation(position) {
    if (!mqttClient || !mqttClient.connected) return;
    
    var locationData = {
        timestamp: new Date().toISOString(),
        longitude: position[0],
        latitude: position[1],
        time: new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) // 北京时区时间
    };
    
    // 发布到当前订阅的主题（如果用户自定义了主题，也会发布到自定义主题）
    mqttClient.publish(subscribedTopic, JSON.stringify(locationData));
}

// ========== 轨迹回放功能 ==========

// 检查位置是否在围栏内（仅返回状态，不触发告警）
function checkFenceStatus(position) {
    // 检查是否在任一固定围栏内
    for (var i = 0; i < allFences.length; i++) {
        if (isPointInPolygon(position, allFences[i].points)) {
            return true;
        }
    }
    
    // 检查是否在自定义围栏内
    if (customFencePolygon) {
        var path = customFencePolygon.getPath();
        if (path && path.length > 0) {
            var customInside = isPointInPolygon(position, path.map(function(point) {
                return [point.lng, point.lat];
            }));
            if (customInside) return true;
        }
    }
    
    return false;
}

// 开始轨迹回放（支持历史数据）
function startReplay(deviceId, startTime, endTime) {
    if (isReplaying) {
        alertInfo("已经在回放中！请先停止当前回放");
        return;
    }
    
    // 显示加载提示
    alertInfo("正在加载历史轨迹数据...");
    
    // 加载历史轨迹数据（使用回调方式）
    if (deviceId || startTime || endTime) {
        // 使用指定的参数从后端API加载历史数据
        loadHistoryTrackData(deviceId, startTime, endTime, function(historyData) {
            if (historyData.length < 2) {
                alertInfo("没有足够的轨迹数据进行回放！请检查时间范围或设备ID");
                return;
            }
            
            // 开始回放
            startReplayWithData(historyData);
        });
    } else {
        // 如果没有指定参数，使用当前会话的轨迹点
        var historyData = trackPoints.map(function(pos, index) {
            return {
                timestamp: Math.floor(Date.now() / 1000) + index,
                position: pos,
                deviceId: currentDeviceId,
                time: new Date().toLocaleString('zh-CN')
            };
        });
        
        if (historyData.length < 2) {
            alertInfo("没有足够的轨迹数据进行回放！请先连接MQTT接收数据或选择历史时间段");
            return;
        }
        
        startReplayWithData(historyData);
    }
}

// 使用加载的数据开始回放
function startReplayWithData(historyData) {
    isReplaying = true;
    replayIndex = 0;
    replayData = historyData; // 存储要回放的数据
    
    // 清除实时跟踪
    if (isTracking) {
        isTracking = false;
    }
    
    // 创建回放标记
    var firstPosition = historyData[0].position;
    if (!trackingMarker) {
        trackingMarker = new AMap.Marker({
            position: firstPosition,
            icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
            map: map,
            title: '回放目标'
        });
    } else {
        trackingMarker.setPosition(firstPosition);
        trackingMarker.setTitle('回放目标');
    }
    
    // 将地图中心移动到第一个点
    map.setCenter(firstPosition);
    
    // 清空轨迹线并重新创建
    if (trackingLine) {
        trackingLine.setMap(null);
    }
    
    // 根据第一个点是否在围栏内设置初始颜色
    var firstIsInsideFence = checkFenceStatus(firstPosition);
    var initialColor = firstIsInsideFence ? '#FF0000' : '#3366FF';
    
    trackingLine = new AMap.Polyline({
        path: [],
        strokeColor: initialColor,
        strokeWeight: 3,
        strokeOpacity: 0.8,
        zIndex: 60,
    });
    trackingLine.setMap(map);
    
    // 开始回放
    replayTrack();
    
    alertInfo("开始轨迹回放，共 " + historyData.length + " 个轨迹点");
}

// 暂停回放
function pauseReplay() {
    if (replayTimer) {
        clearTimeout(replayTimer);
        replayTimer = null;
    }
    isReplaying = false;
    alertInfo("轨迹回放已暂停");
}

// 停止回放
function stopReplay() {
    if (replayTimer) {
        clearTimeout(replayTimer);
        replayTimer = null;
    }
    isReplaying = false;
    replayIndex = 0;
    
    // 重置轨迹线
    if (trackingLine) {
        trackingLine.setPath([]);
    }
    
    alertInfo("轨迹回放已停止");
}

// 回放轨迹（在回放时实时计算围栏状态并设置颜色）
function replayTrack() {
    if (!isReplaying || !replayData || replayIndex >= replayData.length) {
        isReplaying = false;
        alertInfo("轨迹回放结束");
        return;
    }
    
    var trackPoint = replayData[replayIndex];
    var position = trackPoint.position;
    
    // 检查当前位置是否在围栏内（实时计算，用于轨迹颜色）
    var isInsideFence = checkFenceStatus(position);
    
    // 更新回放标记位置
    if (trackingMarker) {
        trackingMarker.setPosition(position);
        trackingMarker.setTitle('回放目标 - ' + (trackPoint.time || '') + ' ' + (trackPoint.deviceId || ''));
    }
    
    // 更新轨迹线
    var currentPath = trackingLine.getPath();
    currentPath.push(position);
    trackingLine.setPath(currentPath);
    
    // 根据当前位置是否在围栏内更新轨迹颜色
    // 围栏内：红色(#FF0000)，围栏外：蓝色(#3366FF)
    var lineColor = isInsideFence ? '#FF0000' : '#3366FF';
    trackingLine.setOptions({
        strokeColor: lineColor
    });
    
    // 可选：自动调整地图视野跟随标记
    map.setCenter(position);
    
    replayIndex++;
    
    // 计算下一个点的延迟时间（根据时间戳差值）
    var delay = 500; // 默认500ms
    if (replayIndex < replayData.length) {
        var currentTimestamp = replayData[replayIndex - 1].timestamp;
        var nextTimestamp = replayData[replayIndex].timestamp;
        if (currentTimestamp && nextTimestamp) {
            var timeDiff = nextTimestamp - currentTimestamp;
            // 如果时间差太大，限制最大延迟为5秒
            delay = Math.min(Math.max(timeDiff * 1000, 100), 5000);
        }
    }
    
    // 继续回放下一个点
    replayTimer = setTimeout(function() {
        replayTrack();
    }, delay);
}

// 显示历史轨迹回放对话框
function showReplayDialog() {
    var dialog = document.getElementById('replayDialog');
    if (!dialog) {
        alertInfo('回放对话框未找到');
        return;
    }
    
    // 加载设备ID列表（从后端API获取）
    var deviceSelect = document.getElementById('replayDeviceId');
    if (deviceSelect) {
        // 清空现有选项（保留"所有设备"）
        deviceSelect.innerHTML = '<option value="all">所有设备</option>';
        
        // 从后端API获取可用设备
        getAvailableDeviceIds(function(deviceIds) {
            deviceIds.forEach(function(deviceId) {
                var option = document.createElement('option');
                option.value = deviceId;
                option.textContent = deviceId;
                deviceSelect.appendChild(option);
            });
        });
    }
    
    // 设置默认时间（最近24小时）
    var endTime = new Date();
    var startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);
    
    var startTimeInput = document.getElementById('replayStartTime');
    var endTimeInput = document.getElementById('replayEndTime');
    
    if (startTimeInput) {
        startTimeInput.value = formatDateTimeLocal(startTime);
    }
    if (endTimeInput) {
        endTimeInput.value = formatDateTimeLocal(endTime);
    }
    
    // 显示对话框
    dialog.style.display = 'block';
}

// 关闭回放对话框
function closeReplayDialog() {
    var dialog = document.getElementById('replayDialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
}

// 确认开始回放
function confirmReplay() {
    var deviceId = document.getElementById('replayDeviceId').value;
    var startTime = document.getElementById('replayStartTime').value;
    var endTime = document.getElementById('replayEndTime').value;
    
    // 转换时间格式（datetime-local返回的是本地时间字符串，需要转换为ISO格式）
    var startTimeISO = startTime ? new Date(startTime).toISOString() : null;
    var endTimeISO = endTime ? new Date(endTime).toISOString() : null;
    
    // 关闭对话框
    closeReplayDialog();
    
    // 开始回放
    startReplay(deviceId === 'all' ? null : deviceId, startTimeISO, endTimeISO);
}

// 格式化日期时间为datetime-local格式
function formatDateTimeLocal(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    var hours = String(date.getHours()).padStart(2, '0');
    var minutes = String(date.getMinutes()).padStart(2, '0');
    
    return year + '-' + month + '-' + day + 'T' + hours + ':' + minutes;
}

// 清除历史轨迹数据（已改为从后端数据库存储，此函数仅清除内存和地图显示）
function clearHistoryTrack() {
    if (!confirm('确定要清除当前显示的轨迹数据吗？此操作不会删除数据库中的数据。')) {
        return;
    }
    
    // 清空内存中的数据（数据库中的数据不受影响）
    historyTrackData = [];
    trackPoints = [];
    
    // 清除地图上的轨迹线
    if (trackingLine) {
        trackingLine.setMap(null);
        trackingLine = null;
    }
    
    // 清除跟踪标记
    if (trackingMarker) {
        trackingMarker.setMap(null);
        trackingMarker = null;
    }
    
    alertInfo('已清除当前显示的轨迹数据（数据库中的数据不受影响）');
}
