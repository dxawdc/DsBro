# DsBro

**DeepSeek 余额与 Token 桌面悬浮球** — Windows 桌面小工具，实时查看 DeepSeek 开发者账户的余额和 Token 用量。

![](build/DsBro_512.ico)

## 功能

- 🔋 **电池图标悬浮球**：用电量百分比直观展示余额占比
- 🎨 **颜色自动变化**：余额 >75% 绿色、>50% 黄色、>20% 橙色、≤20% 红色
- 📊 **详情弹窗**：右键悬浮球查看完整用量数据
- 🔄 **自动同步**：每 6 分钟自动刷新数据
- 🖱️ **可拖拽可缩放**：随意拖动位置，鼠标滚轮或缩放柄调整大小

## 数据来源

全部数据来自 Electron 内置的 DeepSeek 开发者后台页面，**不需要 DeepSeek API Key**。

采集方式：
1. **API 直连** — 调用 DeepSeek 官方 API（`get_user_summary`、`usage/amount`、`usage/cost`）
2. **DOM 抓取** — 从后台页面直接解析表格和文本，作为 API 的兜底

两者结果自动合并，API 数据优先。

### 采集指标

| 指标 | 说明 |
|---|---|
| 充值余额 | 账户余额 |
| 本月消费 | 当月累计支出 |
| 今日消费 | 当天花费金额 |
| 本月 Tokens | 当月 Token 消耗总量 |
| 今日 Token | 输入（缓存命中 / 未命中）、输出、命中率 |

### 悬浮球百分比

```text
充值余额 / (充值余额 + 本月消费)
```

### 缓存命中率

```text
输入（命中缓存）/ (输入（命中缓存）+ 输入（未命中缓存）)
```

## 使用

```powershell
# 安装依赖
npm install

# 开发运行
npm start

# 打包为单 exe 文件
npm run build
```

打包产物在 `dist/DsBro-版本号.exe`，双击直接运行。

### 首次使用

1. 启动应用后，在 DeepSeek 后台窗口登录你的开发者账号
2. 登录后进入用量信息页面，应用自动采集数据
3. 采集到核心数据（余额 + 消费）后，显示悬浮球，自动隐藏后台窗口
4. 右键悬浮球查看详情弹窗

### 注意事项

- 全部数据通过 DeepSeek 开发者后台采集，请确保有有效的开发者账号
- 登录态保存在本地 Electron Session 中，重启后需要重新登录
- 打包的 exe 不包含任何用户数据，可放心分享

## 技术栈

| 层级 | 技术 |
|---|---|
| 框架 | Electron v38 |
| 主进程 | Node.js |
| 渲染进程 | 原生 HTML + CSS + JS |
| 数据持久化 | JSON 文件（`%APPDATA%/dsbro/`） |
| 打包 | electron-builder（portable 目标） |

## 项目结构

```
DsBro/
├── build/
│   └── DsBro_512.ico       # 应用图标
├── src/
│   ├── main.js             # Electron 主进程
│   ├── preload.js          # 安全 IPC 桥接
│   └── renderer/
│       ├── index.html      # UI 布局
│       ├── app.js          # 渲染进程逻辑
│       └── styles.css      # 毛玻璃暗色主题样式
├── scripts/
│   └── afterPack.js        # 打包后清理脚本（精简语言包）
├── package.json
└── README.md
```

## 许可证

MIT
