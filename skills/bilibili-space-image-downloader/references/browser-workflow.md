# 浏览器采集

## 能力契约

脚本是宿主浏览器工具的适配器，必须在满足以下契约的 JS REPL 内导入；它不是独立 Playwright 程序，也不通过本地 HTTP 调用动态 API。Codex 桌面的 `cua_repl` 是已验证的参考实现；其他 agent 环境把自有浏览器工具包装成同一接口后导入。宿主只有截图级 UI 自动化等不满足契约的能力时，停止并说明缺少的能力。

REPL 须支持 `await import('file:///…')` 导入 ESM 并输出返回值。`createCollector({tab, root, cdp, tabs})` 接受：

- `tab`（必需）：已登录 B站的浏览器标签页。
  - `tab.playwright`：Playwright 风格页面 API——`evaluate(fn)`、`waitForTimeout(ms)`、`locator(selector)`、`getByText(text, {exact})`、`getByRole(role, {name, exact})`；locator 支持 `.first()`、`.nth(i)`、`.locator(selector)`、`.filter({visible: true})`、`.count()`、`.evaluate(fn)`、`.click({timeoutMs})`、`.waitFor({state: 'visible', timeoutMs})`。超时参数名是 `timeoutMs`，不是标准 Playwright 的 `timeout`。
  - `tab.url()`、`tab.goto(url)`、`tab.reload()`。
  - `tab.scroll([x, y], 'up'|'down', pages)`、`tab.click([x, y])`，坐标为视口像素。
  - `tab.getAXState({emit: false})`、`tab.getScreenshot({emit: false})`。
- `cdp`（可选）：同一标签页的 CDP 观察——`cdp.send(method, params)`（用到 `Network.enable`、`Network.disable`、`Network.getResponseBody`）与 `cdp.readEvents({methods, afterSequence?, limit?})`，返回 `{cursor, events, hasMore, truncated}`，事件为 `{method, params}`。该能力不可用时传入 `null`，但仍需可见的明确结束标记才能完成。
- `tabs`（可选）：`{list(), get(id)}`；`list()` 返回 `[{id, url}]`，`get(id)` 返回的标签页有 `close()`。用于作者名字没有直接空间链接时核验作者空间 UID。

## 初始化与运行

先按当前宿主工具文档取得已登录浏览器标签页，打开 `https://space.bilibili.com/UID/dynamic` 并读取状态。导入前阅读此脚本和当前浏览器文档；需要观察分页响应时，先读取宿主的 CDP 能力文档（Codex 中为 `tab.capabilities.get('cdp').documentation()`）。使用已获准的 `cdp` 能力仅观察页面自己发起的请求；初始化 `Network.enable` 或后续操作被权限拒绝时，保存 `blocked` 状态与原因并停止，恢复访问后按恢复流程继续。

Codex `cua_repl` 参考示例，替换为已确认的技能路径、归档路径和 Tab 变量：

```javascript
var biliModule = await import('file:///ABSOLUTE_SKILL_PATH/scripts/browser_collect.mjs');
var biliCdp = await tab.capabilities.get('cdp');
var biliCollector = await biliModule.createCollector({tab, root: '/ABSOLUTE_ARCHIVE_PATH', cdp: biliCdp,
  tabs: {list: () => cua.listTabs({browser: 'iab', emit: false}),
    get: id => cua.getTab(id, {browser: 'iab'})}});
nodeRepl.write(await biliCollector.run(38000));
```

其他环境按能力契约包装后同样调用 `createCollector`。持续调用同一 `biliCollector.run(38000)`，直到停止或 `all_captured`。`run(38000, 'discover')` 只发现历史；`run(38000, 'capture')` 只消费已发现队列，适用于定向补抓与样例核验。队列采集结束不会将尚未遍历的历史入口标记完成。完成或停止后调用 `biliCollector.close()` 关闭网络观测。

## 历史入口

动态入口直接来自 UID。图文入口沿空间“投稿 → 图文 → 全部图文”导航；启用专栏时，再选“专栏”。这些名称和定位器应以实际 DOM 为准，界面变化时修正对应适配器。

发现器逐次滚动，立即读取并原子保存帖子。页面自身 `feed/space` 响应可以提供帖子 ID、作者 UID、内容类型和 `has_more`，但其中封面、缩略图或正文图片地址不进入下载队列。持久化时保留必要分页证据，不保存请求 Cookie、完整请求头、指纹参数或签名查询。

只有所选入口明确显示末尾/空列表，或正确 UID 与分类的实际分页响应返回 `has_more=false`，才完成该入口。观测丢失、加载停滞、未新增或显示总数不会被当作结束。中断后重访未完成入口；已有 ID 会合并而不会重复。

## 活动图片

先确认作者 UID、发布时间和正文图片区域。UID 来自作者空间链接或正确 UID 空间实际动态响应中的作者字段；若两者均没有，则点击作者并核验实际打开的空间 URL，再返回详情页。昵称只作显示，头像和评论图片不属于正文。

直接打开路径：点击正文图片后出现 `.pswp--open` 灰色查看器。

九宫格路径：点击图片后只出现页内展开；继续点击可见“查看大图”，再从查看器采集。

每次翻页核对 `.pswp__counter`，等待当前幻灯片与视口对齐、非占位图片加载完成且原生尺寸有效；连续两次观测稳定才保存 `currentSrc`。相邻预加载图片不属于当前页，同一 URL 出现在相邻页可以是合法重复。保留各页对应关系，下载后按哈希去重。

专栏可能包含多个独立图库，应逐组打开并累加正文序号，记录每组局部页码和张数。同一正文共存多种图片布局时，按正文出现顺序串联全部布局的采集组，不得只取第一种布局。正文图片总数必须等于各组张数之和；查看器总张数必须等于当前组张数或全帖期望总数（后者合并为单组一次采完），介于两者之间或存在无法归属的正文图片时，该帖判失败并保留证据，不猜测序号。脚本通过实际位置滚动使图片中心可见后点击；狭窄窗口导致中心无法进入视口时，才按实际可见区域和命中节点定位点击点。独立图库之间重新载入正文，避免关闭按钮所在位置触发导航栏悬浮菜单。

当图片结构、作者或张数无法确认时，将帖子列为失败，保留证据并修正适配器后补抓，不能用缩略图地址替代。
