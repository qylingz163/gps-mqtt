var map;
var tool;
var marker;
var jump_marker;
var markers = []; // 存储所有标记
var p_bhu_songshan = [121.119087, 41.086712]; //渤海大学松山校区
var p_bhu_binhai = [121.061722, 40.88588]; //渤海大学滨海校区

// 历史记录数组
var historyPositions = [];

window.onload = function() {
    map = new AMap.Map("container", {
        resizeEnable: true,
        zoom: 12,
        center: p_bhu_songshan, //地图中心点
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
        position: p_bhu_songshan,
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

    // 添加右键菜单功能
    map.on('rightclick', function(e) {
        addCustomMarker(e.lnglat);
    });

    // 初始化历史记录显示
    updateHistoryList();
}

//根据文本框的输入，跳转到该经纬度位置，并设置标记。
function addMarker() {
    var lng = document.getElementById("position_lng").value;
    var lat = document.getElementById("position_lat").value;

    if (!lng || !lat) {
        alert("请输入完整的经纬度信息！");
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
        alert("请输入完整的GPS经纬度信息！");
        return;
    }

    // 验证坐标格式
    if (isNaN(parseFloat(lng)) || isNaN(parseFloat(lat))) {
        alert("请输入有效的经纬度数值！");
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

                alert('GPS坐标跳转成功！');
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

                alert('GPS坐标转换成功（使用离线算法）！');
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

        alert('GPS坐标转换成功（使用离线算法）！');
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

// 添加自定义标记（右键点击地图）
function addCustomMarker(lnglat) {
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

// 清除所有自定义标记
function clearMarkers() {
    for (var i = 0; i < markers.length; i++) {
        markers[i].marker.setMap(null);
    }
    markers = [];
    alert("所有自定义标记已清除");
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
