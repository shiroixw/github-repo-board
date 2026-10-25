# GitHub Repo Active Board

一个 Tampermonkey / Violentmonkey 用户脚本：在 GitHub 仓库页右下角注入**可折叠看板**，直接浏览近 30 天活跃的 Issues 与 Pull Requests，点一下就跳过去，不用来回切页。

```text
┌─────────────────────────────────────┐
│ ● 活跃看板  shiroixw/OpenInNewTab ⑨ ⟳ ▾ │
├─────────────────────────────────────┤
│ [ Issues 5 ] [ PRs 4 ]     排序 ▾    │
│ 搜索标题 / #编号 / 作者               │
│ ● #41 某些页面下标记过的链接…          │
│      alice · 14 小时前 · 💬 5  bug    │
│ ◆ #29 feat: 支持新标签页打开行为       │
│      shiroixw · 5 分钟前 · 💬 3       │
├─────────────────────────────────────┤
│ 近 30 天活跃 · 更新于刚刚  Token □新标签页 │
└─────────────────────────────────────┘
```

## 功能

- **可折叠面板**：点标题栏或 `▾` 折叠，状态持久化；快捷键 `Alt + B`
- **Issues / PRs 双 Tab**：各自显示活跃数量角标；PR 紫色、Issue 绿色，一眼区分
- **“活跃”定义**：取仓库最近更新的 100 个 open 条目，过滤出近 **30 天**内有更新的
- **条目信息**：`#编号`、标题（两行截断）、作者、相对更新时间、评论数、最多 3 个 label、Draft 标记
- **点击跳转**：默认新标签页打开，可在底栏切回当前页
- **搜索 & 排序**：按标题 / `#编号` / 作者筛选；支持最近更新、最新创建、评论最多三种排序
- **缓存**：每个仓库 `sessionStorage` 缓存 5 分钟，命中缓存不消耗 API 额度，`⟳` 可强制刷新
- **SPA 适配**：监听 GitHub 的 `turbo:load` / `pjax:end` / `popstate`，切仓库自动重载；面板被页面重渲染移除后会自动挂回

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）
2. 打开下面的原始文件链接，扩展会提示安装：

   <https://raw.githubusercontent.com/shiroixw/github-repo-board/main/github-repo-board.user.js>

   或：Tampermonkey 面板 → 添加新脚本 → 粘贴本仓库 `github-repo-board.user.js` 的内容 → 保存

装好后打开任意仓库页（含 issue / PR 页）即可看到面板。

## 关于 API 额度

脚本走 GitHub 公开 REST API（`/repos/{owner}/{repo}/issues`），未登录时全局限额 **60 次/小时**，多仓库频繁切换可能触发限流。

被限流时面板会给出「填写 Token →」入口，粘贴一个 [Personal Access Token](https://github.com/settings/tokens)（无需任何 scope，公开仓库只读即可）后额度提升到 **5000 次/小时**。Token 只存在你浏览器的 `localStorage`（key `ghab:token`），不会发往除 `api.github.com` 之外的任何地方。

## 可调参数

脚本顶部常量区：

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTIVE_DAYS` | `30` | 多少天内有更新算“活跃” |
| `LIST_LIMIT` | `80` | 列表最多渲染条数 |
| `CACHE_TTL` | `5 * 60 * 1000` | 缓存时长（毫秒） |

## 兼容性

Chrome / Edge / Firefox + Tampermonkey、Violentmonkey。脚本为单文件、零依赖、`@grant none`，也可直接粘到 DevTools Console 里试跑。

## License

[MIT](LICENSE)
