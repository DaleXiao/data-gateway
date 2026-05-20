# MemCare Dashboard — Build Spec

## 目标
构建 `memcare.openclawd.co` — Cindy 的记忆健康监控看板，纯静态 HTML，部署到 Cloudflare Pages。

## 设计风格
参考 impeccable.style 的深色极简美学：
- **深色主题**：背景 #0a0a0f ~ #12121a，卡片 #1a1a2e ~ #16162a
- **强调色**：主色 #6c5ce7 紫色系，辅助 #00cec9 青色，警告 #fdcb6e 黄色，危险 #e17055 橙红
- **字体**：Inter/系统字体，数字用等宽
- **圆角卡片**：16px 圆角，subtle border，微妙 glow 效果
- **动效**：进场动画（fade-in + slide-up），数字滚动动画，hover 微交互
- **数据看板风格**：dashboard grid layout，信息密度高但不拥挤

## 数据来源
构建时读取 `../../memory/health/` 下的 JSON 文件（由 memory-health.sh 每日生成）。
当前示例数据：

```json
{
  "date": "2026-04-07",
  "collectedAt": "2026-04-07T11:41:56Z",
  "dailyLog": {
    "exists": true,
    "lines": 80,
    "sizeBytes": 5646,
    "entries": 66,
    "yesterdayEntries": 24,
    "totalLogs": 67
  },
  "graph": {
    "exists": true,
    "entities": 4123,
    "relations": 6051,
    "sizeBytes": 2326528,
    "newEntities": 0,
    "newRelations": 0,
    "typeDistribution": {"concept":751,"tool":621,"lesson":579,"interest":365,"milestone":304,"preference":297,"decision":282,"event":231,"service":201,"project":116}
  },
  "lancedb": {
    "exists": true,
    "sizeBytes": 67743564,
    "files": 8265
  },
  "distilled": {
    "topicsCount": 4,
    "projectsCount": 27,
    "topicsSizeBytes": 44509,
    "projectsSizeBytes": 87402,
    "topicsLastModified": 1775527618,
    "projectsLastModified": 1775527578
  },
  "system": {
    "diskUsagePercent": 30,
    "memoryDirSizeBytes": 3452565
  },
  "trend": [
    {"date":"2026-04-01","entities":4123,"relations":6051,"logEntries":15,"lancedbSize":67743564},
    {"date":"2026-04-02","entities":4123,"relations":6051,"logEntries":21,"lancedbSize":67743564},
    {"date":"2026-04-03","entities":4123,"relations":6051,"logEntries":31,"lancedbSize":67743564},
    {"date":"2026-04-04","entities":4123,"relations":6051,"logEntries":15,"lancedbSize":67743564},
    {"date":"2026-04-05","entities":4123,"relations":6051,"logEntries":15,"lancedbSize":67743564},
    {"date":"2026-04-06","entities":4123,"relations":6051,"logEntries":24,"lancedbSize":67743564},
    {"date":"2026-04-07","entities":4123,"relations":6051,"logEntries":66,"lancedbSize":67743564}
  ]
}
```

## 页面布局（Dashboard Grid）

### Header
- 标题 "MemCare" + 副标题 "Memory Health Dashboard"
- 右上角：最后更新时间 + 整体健康评分（圆环图）

### Row 1 — 核心指标卡片（4列）
1. **Entities** — 大数字 4,123 + 今日新增 +N（绿色/红色）
2. **Relations** — 大数字 6,051 + 今日新增
3. **Daily Entries** — 大数字 66 + 对比昨天变化
4. **LanceDB** — 64.6 MB + 文件数 8,265

### Row 2 — 图表区（2列）
1. **7-Day Activity Wave**（波形图/面积图）— 每日 log entries 趋势，带渐变填充
2. **Entity Type Distribution**（圆环图/donut chart）— concept/tool/lesson/interest 等分布

### Row 3 — 图表区（2列）
1. **Knowledge Growth**（柱状图）— 7天的 entities + relations 增长
2. **Storage Overview**（横向柱状图或堆叠条）— graph/lancedb/topics/projects 各自占比

### Row 4 — 系统状态
- 磁盘使用率（进度条）
- 蒸馏覆盖（topics/projects 数量 + 最后更新时间）
- 日志连续性（连续多少天有日志）

### Footer
- "Cindy's Memory · Updated daily at 05:00 CST"

## 技术约束
- **纯静态 HTML** — 单个 index.html，所有 CSS/JS 内联
- **图表用 SVG** — 不引入外部库，手写 SVG 路径（保持轻量）
- **响应式** — 桌面 4 列 grid，平板 2 列，手机 1 列
- **数据内嵌** — 构建时由 build.sh 将 JSON 数据注入 HTML 的 `<script>` 标签
- **性能** — 首屏 <100KB gzipped，无外部依赖

## 构建脚本 build.sh 逻辑
1. 读取 `../../memory/health/` 下所有 JSON（最近 30 天）
2. 合并为 `window.__MEMCARE_DATA__` 对象
3. 将 index.template.html 中的 `{{DATA_PLACEHOLDER}}` 替换为实际数据
4. 输出到 `dist/index.html`

## 文件结构
```
projects/memcare-site/
├── BUILD_SPEC.md        (this file)
├── index.template.html  (template with {{DATA_PLACEHOLDER}})
├── build.sh             (inject data → dist/)
└── dist/
    └── index.html       (built output, deployed to CF Pages)
```
