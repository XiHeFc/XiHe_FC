(function () {
  'use strict';

  // WED 遥测协议
  // 帧格式: 0x55 0xAA | payloadLen | payload | SUM8
  // payload = 20 x uint16 big-endian, 共 40 字节
  // SUM8 = (payloadLen + payload 累加和) & 0xFF
  const WED = {
    id: 'wed-telemetry',
    name: 'WED 遥测协议',
    protocol: 'WED',
    header: '55AA',
    headerBytes: [0x55, 0xAA],
    payloadBytes: 40,
    channelCount: 20,
    checksum: 'SUM8',
    byteOrder: 'big',
    maxFrameBytes: 280,
    description: '55 AA + 长度(1) + 40B 遥测负载 + SUM8；20 通道 uint16 大端',
    channels: [
      { name: 'MG12 气体传感器', unit: 'ADC', decimals: 0, scale: 1, display: 'raw', range: [0, 65535], description: 'DATA[0..1]，16 位大端原始值' },
      { name: 'JX90614 温度 1', unit: '°C', decimals: 2, scale: 0.01, display: 'raw', invalidRawValues: [36863], range: [-50, 500], description: 'DATA[2..3]，实际温度 ×100' },
      { name: 'MQ2 气体传感器', unit: 'ADC', decimals: 0, scale: 1, display: 'raw', range: [0, 65535], description: 'DATA[4..5]，16 位大端原始值' },
      { name: 'PM0.3', unit: '个/0.1L', decimals: 0, scale: 1, display: 'raw', range: [0, 65535], description: 'DATA[6..7]，PM 0.3um 粒子计数' },
      { name: 'PM2.5', unit: '个/0.1L', decimals: 0, scale: 1, display: 'raw', range: [0, 65535], description: 'DATA[8..9]，PM 2.5um 粒子计数' },
      { name: 'PM10', unit: '个/0.1L', decimals: 0, scale: 1, display: 'raw', range: [0, 65535], description: 'DATA[10..11]，PM 10um 粒子计数' },
      { name: 'AHT20 温度', unit: '°C', decimals: 2, scale: 0.01, display: 'raw', range: [-50, 150], description: 'DATA[12..13]，实际温度 ×100' },
      { name: 'AHT20 湿度', unit: '%RH', decimals: 2, scale: 0.01, display: 'raw', range: [0, 100], description: 'DATA[14..15]，实际湿度 ×100' },
      { name: 'JX90614 温度 2', unit: '°C', decimals: 2, scale: 0.01, display: 'raw', invalidRawValues: [36863], range: [-50, 500], description: 'DATA[16..17]，实际温度 ×100' },
      { name: 'JX90614 温度 3', unit: '°C', decimals: 2, scale: 0.01, display: 'raw', invalidRawValues: [36863], range: [-50, 500], description: 'DATA[18..19]，实际温度 ×100' },
      { name: 'JX90614 温度 4', unit: '°C', decimals: 2, scale: 0.01, display: 'raw', invalidRawValues: [36863], range: [-50, 500], description: 'DATA[20..21]，实际温度 ×100' },
      { name: 'PM1.0', unit: '个/0.1L', decimals: 0, scale: 1, display: 'raw', range: [0, 65535], description: 'DATA[22..23]，PM 1.0um 粒子计数' },
      { name: 'IIC 诊断版本', unit: '', decimals: 0, scale: 1, display: 'hex16', range: [0, 65535], description: 'DATA[24..25]，固定 0x1C01' },
      { name: 'JX更新计数1/2', unit: 'count', decimals: 0, scale: 1, display: 'split_bytes', byteNames: ['JX1', 'JX2'], range: [0, 65535], description: '高字节 JX1 更新计数，低字节 JX2 更新计数' },
      { name: 'JX更新计数3/4', unit: 'count', decimals: 0, scale: 1, display: 'split_bytes', byteNames: ['JX3', 'JX4'], range: [0, 65535], description: '高字节 JX3 更新计数，低字节 JX4 更新计数' },
      { name: 'AHT/ADC更新计数', unit: 'count', decimals: 0, scale: 1, display: 'split_bytes', byteNames: ['AHT20', 'ADC'], range: [0, 65535], description: '高字节 AHT20，低字节 ADC' },
      { name: 'JX完成计数1/2', unit: 'count', decimals: 0, scale: 1, display: 'split_bytes', byteNames: ['JX1', 'JX2'], range: [0, 65535], description: '高字节 JX1，低字节 JX2' },
      { name: 'JX完成计数3/4', unit: 'count', decimals: 0, scale: 1, display: 'split_bytes', byteNames: ['JX3', 'JX4'], range: [0, 65535], description: '高字节 JX3，低字节 JX4' },
      { name: 'AHT/ADC完成计数', unit: 'count', decimals: 0, scale: 1, display: 'split_bytes', byteNames: ['AHT20', 'ADC'], range: [0, 65535], description: '高字节 AHT20，低字节 ADC' },
      { name: 'IIC应答状态', unit: '', decimals: 0, scale: 1, display: 'ack_flags', bitLabels: ['JX1', 'JX2', 'JX3', 'JX4', 'AHT20', 'ADC'], range: [0, 65535], description: '低 8 位 ACK 标志，1 表示未应答' }
    ]
  };

  // ===== 飞控遥测（XiHe_F4_FC_2）：帧格式和 WED 一样，20 个槽位换成姿态闭环链路 =====
  // 两条和传感器规格不同的约定，飞控侧照 description 里的公式发就行：
  //   ① 角度/角速度/扰动有负值，而负载是无符号 uint16 —— 飞控侧先加偏置再放大（raw = (x+bias)/scale），
  //      GCS 侧交给通道的「倍率 / 偏移」还原，所以这里的 scale 保持 1（decode 不再二次缩放）；
  //   ② 预警阈值按飞控工况给：电机怠速 PWM=1100 不能被判成低值，电机通道的 warnLow 压到 1040。
  function fcChannel(name, unit, decimals, channelScale, bias, range, warnLow, warnHigh, description) {
    return {
      name: name,
      unit: unit,
      decimals: decimals,
      display: 'raw',
      scale: 1,
      channelScale: channelScale,
      channelOffset: -bias,
      range: range,
      warnLow: warnLow,
      warnHigh: warnHigh,
      description: description
    };
  }
  // 有符号量：raw = (x + bias) / scale，预警阈值对称
  function fcSigned(name, unit, decimals, channelScale, bias, range, warn, description) {
    return fcChannel(name, unit, decimals, channelScale, bias, range, -warn, warn, description);
  }
  const FC_CHANNELS = [
    fcSigned('横滚角', '\u00b0', 2, 0.01, 180, [-180, 180], 150, '槽0 · raw=(deg+180)×100，零位 18000 · roll'),
    fcSigned('俯仰角', '\u00b0', 2, 0.01, 180, [-180, 180], 150, '槽1 · raw=(deg+180)×100，零位 18000 · pitch'),
    fcSigned('偏航角', '\u00b0', 2, 0.01, 180, [-180, 180], 150, '槽2 · raw=(deg+180)×100，零位 18000 · yaw'),
    fcSigned('横滚角速度', '\u00b0/s', 1, 0.1, 1000, [-1000, 1000], 900, '槽3 · raw=(deg_s+1000)×10，零位 10000 · 飞控先把 rad/s 转 °/s'),
    fcSigned('俯仰角速度', '\u00b0/s', 1, 0.1, 1000, [-1000, 1000], 900, '槽4 · raw=(deg_s+1000)×10，零位 10000 · 飞控先把 rad/s 转 °/s'),
    fcSigned('偏航角速度', '\u00b0/s', 1, 0.1, 1000, [-1000, 1000], 900, '槽5 · raw=(deg_s+1000)×10，零位 10000 · 飞控先把 rad/s 转 °/s'),
    fcSigned('陀螺 X 原始', '\u00b0/s', 1, 0.1, 1000, [-1000, 1000], 900, '槽6 · raw=(deg_s+1000)×10，零位 10000 · imu->gyro_roll（未滤）'),
    fcSigned('陀螺 Y 原始', '\u00b0/s', 1, 0.1, 1000, [-1000, 1000], 900, '槽7 · raw=(deg_s+1000)×10，零位 10000 · imu->gyro_pitch（未滤）'),
    fcSigned('陀螺 Z 原始', '\u00b0/s', 1, 0.1, 1000, [-1000, 1000], 900, '槽8 · raw=(deg_s+1000)×10，零位 10000 · imu->gyro_yaw（未滤）'),
    fcSigned('控制量 U 横滚', '', 3, 0.001, 1, [-2, 2], 1.6, '槽9 · raw=(u+1)×1000，零位 1000 · LADRC 输出 u≈±1'),
    fcSigned('控制量 U 俯仰', '', 3, 0.001, 1, [-2, 2], 1.6, '槽10 · raw=(u+1)×1000，零位 1000 · LADRC 输出 u≈±1'),
    fcSigned('控制量 U 偏航', '', 3, 0.001, 1, [-2, 2], 1.6, '槽11 · raw=(u+1)×1000，零位 1000 · LADRC 输出 u≈±1'),
    fcChannel('电机 LF', 'PWM', 0, 1, 0, [1000, 1600], 1040, 1480, '槽12 · raw=PWM · motor[0] LF（1100 怠速 / 1500 满）'),
    fcChannel('电机 LA', 'PWM', 0, 1, 0, [1000, 1600], 1040, 1480, '槽13 · raw=PWM · motor[1] LA（1100 怠速 / 1500 满）'),
    fcChannel('电机 RF', 'PWM', 0, 1, 0, [1000, 1600], 1040, 1480, '槽14 · raw=PWM · motor[2] RF（1100 怠速 / 1500 满）'),
    fcChannel('电机 RA', 'PWM', 0, 1, 0, [1000, 1600], 1040, 1480, '槽15 · raw=PWM · motor[3] RA（1100 怠速 / 1500 满）'),
    fcSigned('观测器 z1 角度估计', '\u00b0', 2, 0.01, 180, [-180, 180], 150, '槽16 · raw=(deg+180)×100，零位 18000 · ESO z1'),
    fcSigned('观测器 z2 总扰动', '', 3, 0.001, 20, [-20, 20], 16, '槽17 · raw=(z2+20)×1000，零位 20000 · ESO z2'),
    fcSigned('观测器 z2 低通', '', 3, 0.001, 20, [-20, 20], 16, '槽18 · raw=(lft_z2+20)×1000，零位 20000 · ESO lft_z2'),
    fcChannel('机体 Z 加速度', 'm/s²', 2, 0.01, 30, [-30, 50], -24, 40, '槽19 · raw=(acc+30)×100，零位 3000 · imu->acc_yaw（振动观察）')
  ];

  const FC_WED = {
    id: 'wed-fc',
    idPrefix: 'wed-fc',
    name: 'WED 飞控遥测',
    protocol: 'WED',
    header: '55AA',
    headerBytes: [0x55, 0xAA],
    payloadBytes: 40,
    channelCount: 20,
    checksum: 'SUM8',
    byteOrder: 'big',
    maxFrameBytes: 280,
    description: '55 AA + 长度(1) + 40B 负载 + SUM8；20 路 uint16 大端，飞控姿态闭环（XiHe_F4_FC_2）',
    channels: FC_CHANNELS
  };

  // WED 家族按 protocolId 分规格：装传感器用 wed-telemetry，装飞控用 wed-fc
  const WED_PROFILES = {};
  WED_PROFILES[WED.id] = WED;
  WED_PROFILES[FC_WED.id] = FC_WED;

  function wedProfileId(engine) {
    const id = String(engine && engine.protocolId || '');
    return WED_PROFILES[id] ? id : WED.id;
  }

  function wedProfile(engine) {
    return WED_PROFILES[wedProfileId(engine)];
  }
  const PRESET_ORDER = ['csv', 'json', 'ascii', 'hex', 'wed', 'wedfc'];
  const PRESETS = {
    // 逗号分隔浮点（Arduino Serial.print 一行一串数）：行首标签如 samples: 可有可无，
    // 通道数由每行的数值个数决定；首行若是名字表（acc_roll,acc_pitch,…）就用它命名通道。
    csv: {
      key: 'csv',
      id: 'csv',
      name: 'CSV 浮点引擎',
      protocol: 'CSV',
      header: '',
      tail: '',
      terminator: '\n',
      checksum: 'NONE',
      byteOrder: 'little',
      hexScale: 1,
      payloadBytes: 0,
      channelCount: 0,
      description: '每行逗号分隔浮点数，行首标签（samples:）可有可无；通道按每行数值个数自动识别',
      summary: '逗号分隔浮点 · 可选 samples: 标签 · 通道自适应',
      sample: 'samples: 0.0998, 0.1987, 0.2955, 0.3894'
    },
    json: {
      key: 'json',
      id: 'json',
      name: 'JSON 数据引擎',
      protocol: 'JSON',
      header: '{',
      tail: '}',
      terminator: '\n',
      checksum: 'NONE',
      byteOrder: 'little',
      hexScale: 10,
      payloadBytes: 0,
      channelCount: 0,
      description: '轻量文本遥测，字段名直接作为通道名',
      summary: '对象/数组 · 无校验',
      sample: '{"t":1.23,"ch":{"voltage":12.4}}'
    },
    ascii: {
      key: 'ascii',
      id: 'ascii',
      name: 'ASCII 字段引擎',
      protocol: 'ASCII',
      header: 'XH[',
      tail: ']',
      terminator: '\r\n',
      checksum: 'CRC16',
      byteOrder: 'little',
      hexScale: 10,
      payloadBytes: 0,
      channelCount: 0,
      description: '适合 key:value 字段流，字段顺序任意',
      summary: '逗号/分号分隔 · CRC16',
      sample: 'XH[voltage:12.4,current:1.8]*A1B2\r\n'
    },
    hex: {
      key: 'hex',
      id: 'hex',
      name: 'HEX 二进制引擎',
      protocol: 'HEX',
      header: 'AA55',
      tail: '55AA',
      terminator: '',
      checksum: 'CRC32',
      byteOrder: 'little',
      hexScale: 10,
      payloadBytes: 0,
      channelCount: 0,
      description: '自定义二进制帧，帧头帧尾可配',
      summary: 'AA55…55AA · CRC32',
      sample: 'AA55 04D2 01F4 55AA 1A2B3C4D'
    },
    wed: {
      key: 'wed',
      id: 'wed-telemetry',
      protocol: 'WED',
      protocolId: 'wed-telemetry',
      name: 'WED 遥测协议',
      header: '55AA',
      tail: '',
      terminator: '',
      checksum: 'SUM8',
      byteOrder: 'big',
      hexScale: 1,
      payloadBytes: 40,
      channelCount: 20,
      description: '定长遥测帧，无分隔符，高帧率下传',
      summary: '55AA + 40B + SUM8 · 20 通道',
      sample: '55 AA 28 ' + '00 01 '.repeat(19) + '00 01 ' + '6B'
    },
    wedfc: {
      key: 'wedfc',
      id: 'wed-fc',
      protocol: 'WED',
      protocolId: 'wed-fc',
      name: 'WED 飞控遥测',
      header: '55AA',
      tail: '',
      terminator: '',
      checksum: 'SUM8',
      byteOrder: 'big',
      hexScale: 1,
      payloadBytes: 40,
      channelCount: 20,
      description: '姿态闭环 20 路：角度/角速度/陀螺/控制量/电机/自抗扰观测器，仅接收方向',
      summary: '55AA + 40B + SUM8 · 20 通道（飞控）',
      // 全零位 + 电机怠速时的合法帧，可直接拿来对拍飞控侧的组帧结果
      sample: '55 AA 28 46 50 46 50 46 50 27 10 27 10 27 10 27 10 27 10 27 10 03 E8 03 E8 03 E8 04 4C 04 4C 04 4C 04 4C 46 50 4E 20 4E 20 0B B8 6A'
    }
  };

  function presetArray() {
    return PRESET_ORDER.map((key) => PRESETS[key]).filter(Boolean);
  }

  function presetByKey(key) {
    const text = String(key || '').toLowerCase();
    const direct = PRESETS[text];
    if (direct) return direct;
    if (text.indexOf('csv') >= 0 || text.indexOf('浮点') >= 0 || text.indexOf('逗号分隔') >= 0) return PRESETS.csv;
    if (text.indexOf('飞控') >= 0 || text.indexOf('wed-fc') >= 0 || text.indexOf('fc') >= 0) return PRESETS.wedfc;
    if (text.indexOf('wed') >= 0 || text.indexOf('55aa') >= 0 || text.indexOf('sum8') >= 0 || text.indexOf('遥测') >= 0) return PRESETS.wed;
    if (text.indexOf('json') >= 0) return PRESETS.json;
    if (text.indexOf('hex') >= 0 || text.indexOf('二进制') >= 0 || text.indexOf('十六进制') >= 0) return PRESETS.hex;
    if (text.indexOf('ascii') >= 0 || text.indexOf('字段') >= 0 || text.indexOf('文本') >= 0) return PRESETS.ascii;
    return PRESET_ORDER.map((k) => PRESETS[k]).find((item) =>
      item.protocol.toLowerCase() === text ||
      String(item.id).toLowerCase() === text ||
      String(item.name).toLowerCase().indexOf(text) >= 0
    ) || null;
  }

  function presetFor(value) {
    const protocol = String(value && value.protocol || '').toUpperCase();
    const protocolId = String(value && value.protocolId || '').toLowerCase();
    const text = String(typeof value === 'string' ? value : value && (value.preset || value.name || value.id) || '').toLowerCase();
    if (protocol === 'WED' || WED_PROFILES[protocolId]) return PRESETS[wedProfileId(value) === FC_WED.id ? 'wedfc' : 'wed'];
    if (protocol) return PRESET_ORDER.map((key) => PRESETS[key]).find((item) => item.protocol === protocol) || null;
    return presetByKey(text);
  }

  function presetEngine(preset, partial) {
    const base = Object.assign({
      id: '',
      name: (preset && preset.name) || '自定义数据引擎',
      protocol: (preset && preset.protocol) || 'ASCII',
      protocolId: (preset && preset.protocolId) || '',
      header: (preset && preset.header) || '',
      tail: (preset && preset.tail) || '',
      terminator: (preset && preset.terminator) || '',
      checksum: (preset && preset.checksum) || 'NONE',
      byteOrder: (preset && preset.byteOrder) || 'little',
      hexScale: Number(preset && preset.hexScale) || 10,
      payloadBytes: Number(preset && preset.payloadBytes) || 0,
      channelCount: Number(preset && preset.channelCount) || 0,
      description: (preset && preset.description) || ''
    }, partial || {});
    if (!base.id) delete base.id;
    return base;
  }

  function isWed(engine) {
    return String(engine && engine.protocol || '').toUpperCase() === 'WED' || Boolean(WED_PROFILES[String(engine && engine.protocolId || '')]);
  }

  function engineConfig(partial) {
    return Object.assign({
      id: 'engine-wed',
      name: WED.name,
      protocol: WED.protocol,
      protocolId: WED.id,
      header: WED.header,
      tail: '',
      terminator: '',
      checksum: WED.checksum,
      byteOrder: WED.byteOrder,
      hexScale: 1,
      payloadBytes: WED.payloadBytes,
      channelCount: WED.channelCount,
      active: false,
      description: WED.description
    }, partial || {});
  }

  function definitions(engine) {
    if (!isWed(engine)) return [];
    return wedProfile(engine).channels;
  }

  function channelTemplates(engine) {
    const profile = wedProfile(engine);
    const defs = definitions(engine);
    const count = Math.max(1, Math.floor(Number(engine && engine.channelCount) || profile.channelCount));
    const templates = [];
    for (let index = 0; index < count; index++) {
      const def = defs[index] || { name: 'CH' + (index + 1), unit: '', decimals: 0, scale: 1, display: 'raw', range: [0, 65535] };
      const range = Array.isArray(def.range) ? [Number(def.range[0]), Number(def.range[1])] : [0, 65535];
      templates.push({
        id: (profile.idPrefix || 'wed') + '-' + String(index + 1).padStart(2, '0'),
        name: def.name,
        unit: def.unit || '',
        color: ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#a3e635'][index % 8],
        range: range,
        // 规格里显式写了阈值就用（飞控规格按工况定过：电机怠速 PWM=1100 不能被判成低值）。
        // 没写的不要从量程猜 —— 传感器规格的量程默认 0..65535，原始 ADC 一旦收到 0xFFFF
        // （传感器无数据）量程就被撑满，按 ±2% 猜出来的线会把所有正常值都判成越限，
        // 表现就是一接上设备满屏告警。null = 这一侧不报警，由用户自己填。
        warnHigh: Number.isFinite(def.warnHigh) ? Number(def.warnHigh) : null,
        warnLow: Number.isFinite(def.warnLow) ? Number(def.warnLow) : null,
        // 偏置换算放通道侧（面板里能直接改），所以 decode 用的 def.scale 保持 1
        scale: Number.isFinite(def.channelScale) ? Number(def.channelScale) : 1,
        offset: Number.isFinite(def.channelOffset) ? Number(def.channelOffset) : 0,
        base: 0,
        amp: 0,
        freq: 0,
        noise: 0,
        waveform: 'sine',
        visible: true,
        remote: true,
        protocolIndex: index,
        protocol: profile.protocol,
        protocolId: profile.id,
        protocolDisplay: def.display || 'raw',
        decimals: def.decimals != null ? def.decimals : 1,
        rawScale: Number(def.scale) || 1,
        invalidRawValues: Array.isArray(def.invalidRawValues) ? def.invalidRawValues.slice() : [],
        byteNames: Array.isArray(def.byteNames) ? def.byteNames.slice() : [],
        bitLabels: Array.isArray(def.bitLabels) ? def.bitLabels.slice() : [],
        description: def.description || ''
      });
    }
    return templates;
  }

  function sum8(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) sum = (sum + (bytes[i] & 0xFF)) & 0xFF;
    return sum;
  }

  function hexBytes(bytes) {
    return Array.from(bytes || []).map(function (b) { return (b & 0xFF).toString(16).padStart(2, '0').toUpperCase(); }).join(' ');
  }

  function payloadLength(engine) {
    return Math.max(2, Number(engine && engine.payloadBytes) || WED.payloadBytes);
  }

  function decodeFrame(raw, engine) {
    const bytes = raw instanceof Uint8Array ? Array.from(raw) : Array.from(raw || []);
    const len = payloadLength(engine);
    if (bytes.length < 4 + len) return { ok: false, error: 'WED 帧长度不足' };
    if (bytes[0] !== WED.headerBytes[0] || bytes[1] !== WED.headerBytes[1]) return { ok: false, error: 'WED 帧头错误' };
    if (bytes[2] !== len) return { ok: false, error: 'WED 负载长度不匹配：' + bytes[2] + ' != ' + len };
    const sumIndex = 3 + len;
    const expected = bytes[sumIndex];
    const actual = sum8(bytes.slice(2, sumIndex));
    if (actual !== expected) return { ok: false, error: 'WED SUM8 校验失败' };
    const defs = definitions(engine);
    const values = {};
    for (let i = 0; i < len / 2; i++) {
      const rawValue = (bytes[3 + i * 2] << 8) | bytes[3 + i * 2 + 1];
      const def = defs[i] || { name: 'CH' + (i + 1), scale: 1 };
      let value = rawValue;
      if (Array.isArray(def.invalidRawValues) && def.invalidRawValues.indexOf(rawValue) >= 0) value = 0;
      else value = rawValue * (Number(def.scale) || 1);
      values[def.name] = value;
    }
    return { ok: true, values: values, t: null, raw: bytes };
  }

  function ingest(chunk, engine, buffer) {
    const list = Array.isArray(buffer) ? buffer.slice() : [];
    Array.from(chunk || []).forEach(function (b) { list.push(b & 0xFF); });
    const len = payloadLength(engine);
    const frameLen = 4 + len;
    const max = Number(engine && engine.maxFrameBytes) || WED.maxFrameBytes;
    if (list.length > Math.max(max * 3, frameLen * 3)) list.splice(0, list.length - Math.max(max, frameLen));
    const frames = [];
    while (list.length >= 4) {
      let index = -1;
      for (let i = 0; i < list.length - 1; i++) {
        if (list[i] === WED.headerBytes[0] && list[i + 1] === WED.headerBytes[1]) { index = i; break; }
      }
      if (index < 0) {
        if (list[list.length - 1] === WED.headerBytes[0]) list.splice(0, list.length - 1);
        else list.length = 0;
        break;
      }
      if (index > 0) list.splice(0, index);
      if (list.length < frameLen) break;
      if (list[2] !== len || frameLen > max) { list.shift(); continue; }
      const expected = list[3 + len];
      const actual = sum8(list.slice(2, 3 + len));
      if (actual !== expected) { list.shift(); continue; }
      const frameBytes = list.slice(0, frameLen);
      frames.push({ raw: Uint8Array.from(frameBytes), bytes: frameBytes, hex: hexBytes(frameBytes) });
      list.splice(0, frameLen);
    }
    return { frames: frames, buffer: list };
  }

  function encode(values, engine) {
    const len = payloadLength(engine);
    const defs = definitions(engine);
    const payload = new Uint8Array(len);
    for (let i = 0; i < len / 2; i++) {
      const def = defs[i] || {};
      const key = def.name || 'CH' + (i + 1);
      const value = Number(values && (values[key] != null ? values[key] : values['CH' + (i + 1)] != null ? values['CH' + (i + 1)] : 0)) || 0;
      const scale = Number(def.scale) || 1;
      const raw = Math.max(0, Math.min(65535, Math.round(value / scale))) & 0xFFFF;
      payload[i * 2] = (raw >> 8) & 0xFF;
      payload[i * 2 + 1] = raw & 0xFF;
    }
    const sum = sum8([len].concat(Array.from(payload)));
    return Uint8Array.from([WED.headerBytes[0], WED.headerBytes[1], len].concat(Array.from(payload), [sum]));
  }

  function encodeHex(values, engine) {
    return hexBytes(encode(values, engine));
  }

  function formatChannelValue(def, value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '--';
    if (def.display === 'hex16') {
      const raw = Math.max(0, Math.min(0xFFFF, Math.trunc(num)));
      return '0x' + raw.toString(16).toUpperCase().padStart(4, '0');
    }
    if (def.display === 'split_bytes') {
      const names = Array.isArray(def.byteNames) ? def.byteNames : ['H', 'L'];
      const raw = Math.max(0, Math.min(0xFFFF, Math.trunc(num)));
      return (names[0] || 'H') + '=' + ((raw >> 8) & 0xFF) + ' ' + (names[1] || 'L') + '=' + (raw & 0xFF);
    }
    if (def.display === 'ack_flags') {
      const labels = Array.isArray(def.bitLabels) ? def.bitLabels : [];
      const flags = Math.trunc(num) & 0xFF;
      const bad = [];
      for (let bit = 0; bit < labels.length; bit++) if (flags & (1 << bit)) bad.push(labels[bit]);
      return bad.length ? 'NACK: ' + bad.join(',') : 'ACK OK';
    }
    const decimals = def.decimals != null ? def.decimals : 1;
    return num.toFixed(Math.max(0, Math.min(6, Number(decimals) || 0)));
  }

  window.XHGCS_PROTOCOL = {
    WED: WED,
    PRESETS: PRESETS,
    PRESET_ORDER: PRESET_ORDER,
    presetArray: presetArray,
    presetByKey: presetByKey,
    presetFor: presetFor,
    presetEngine: presetEngine,
    isWed: isWed,
    WED_PROFILES: WED_PROFILES,
    wedProfile: wedProfile,
    wedProfileId: wedProfileId,
    engineConfig: engineConfig,
    definitions: definitions,
    channelTemplates: channelTemplates,
    decodeFrame: decodeFrame,
    ingest: ingest,
    encode: encode,
    encodeHex: encodeHex,
    formatChannelValue: formatChannelValue,
    sum8: sum8,
    hexBytes: hexBytes
  };

  // 阈值对齐（见 data.js 的 alignThresholdsToProtocol）：协议没声明阈值的通道一律清成「未设」。
  // 放在这里是因为它要协议表才能判，而 data.js 的脚本排在 protocol.js 前面 —— 那边加载时
  // window.XHGCS_PROTOCOL 还不存在。包 try/catch：这里是启动路径，抛出去会白屏。
  try {
    if (window.XHGCS && typeof window.XHGCS.alignThresholdsToProtocol === 'function') {
      window.XHGCS.alignThresholdsToProtocol(WED_PROFILES);
    }
  } catch (err) {
    console.warn('XiHe_GCS: 阈值对齐失败', err);
  }
})();
