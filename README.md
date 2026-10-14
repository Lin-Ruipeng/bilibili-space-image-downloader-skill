# B站空间动态原图下载

Codex 技能 `bilibili-space-image-downloader`：给定 UP 主 UID，收藏当前登录账号可见的全部历史空间动态原图，包含动图，支持断点恢复和失败补抓。专栏正文图片可选；转发、评论区、头像和视频封面不进入收藏。

**原图是灰色遮罩大图查看器实际加载的完整文件。** 技能逐页记录当前图片地址、原生尺寸和加载证据，下载后保存原始字节并校验格式、尺寸、帧数和 SHA-256。

## 安装

需要带有内置浏览器及 `cua_repl` 工具的 Codex 桌面环境、已登录的 B站会话、Python 3.10+、Node.js 20+。Python 脚本使用 requests 和 Pillow；结构校验另需 PyYAML。依赖安装到你选用的 Python 环境：

```bash
python3 -m pip install -r skills/bilibili-space-image-downloader/scripts/requirements.txt
python3 install_skill.py
```

默认安装到 `$CODEX_HOME/skills`，未设置时为 `~/.codex/skills`。已有同名技能时使用 `--update`，旧安装会保留为备份。安装后按 Codex 的技能发现机制重新加载或开启新对话。

## 使用

对 Codex 说：

> 用 $bilibili-space-image-downloader 下载 UID 123456 的全部空间动态原图。

也可以要求“同时包含专栏”或指定保存根目录。默认位置：

```text
~/图片/bilibili/UID/
  年份/日期_帖子ID/001.jpg
  .collection/
  download_manifest.json
  download_manifest.csv
  download_report.json
```

技能由 Codex 操作内置浏览器完成发现和查看器采集。浏览器适配脚本必须通过 `cua_repl` 导入，不能直接作为普通 Node/Playwright 爬虫运行；它复用浏览器登录状态，下载器不读取 Cookie 或密码。

浏览器操作至少间隔三秒；下载最多两个并发，普通网络失败最多重试三次。重复图片按 SHA-256 使用硬链接保留各帖对应关系，无法硬链接时复制。真实格式决定扩展名，GIF、WebP 动图以及 MPO 多图文件均保留原始容器。

再次运行会跳过已校验文件；获取新动态时要求重新扫描全部历史。发生验证码、登录失效、权限拒绝或持续限制会保存进度并停止。仅当历史明确结束、各帖图片齐全并且无失败，才报告完成。

技能操作入口见 [SKILL.md](skills/bilibili-space-image-downloader/SKILL.md)；采集与恢复细节由技能按需读取对应 reference。

## 验证与开发

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node tests/test_browser_core.mjs
```

Python 集成测试启动仅监听本机的临时 HTTP 服务，需要允许本机监听。测试图片由程序生成，仓库不包含真实收藏、个人正文、浏览器凭据或采集清单。

测试覆盖断流续传、失败补抓、动图字节保留、硬链接、空账号、历史未完成、UID 隔离、重采集数量变化，以及活动图片与占位/预加载/过渡状态的区分。真实浏览器回归结果见 [VALIDATION.md](VALIDATION.md)。

页面结构可能变化；无法确认当前活动原图或历史末尾时，技能会报告未完成，保留进度供修正适配器后继续。MIT 许可覆盖代码与技能文档，收藏图片不纳入仓库或本项目许可。
