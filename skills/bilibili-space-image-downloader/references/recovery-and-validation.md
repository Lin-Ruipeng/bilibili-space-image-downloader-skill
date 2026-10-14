# 恢复与验证

## 进度与目录

归档根目录是 `archive.py` 输出的 UID 子目录。该目录含年份图片、`.collection/index.json`、逐帖采集文件、下载 SQLite 数据库、临时文件及 JSON/CSV 清单。脚本安装目录只含程序，不保存运行数据。

UID 与帖子 ID 都是字符串。每张图记录正文来源、发布时间、正文、序号、查看器实际 URL、尺寸、局部图库页码、加载证据和观察时间；下载记录补充保存位置、格式、字节数、SHA-256、帧数、复用方式、尝试次数与失败原因。

浏览器每张图原子保存，下载器每次状态变化提交 SQLite 事务。未完成帖子恢复时重新打开查看器核验；多图库正文、发布时间和分组结构一致时复用已完整采集的前序图库，从未完成组继续。已完成帖子保持缓存。资源改变则重新下载并校验；已有不同文件不会被覆盖。重新采集减少图片张数时，失效的下载行标记 inactive，旧文件保持原位。

## 恢复操作

- 普通中断：用同样 UID、保存根目录和范围初始化，再创建新的采集器并继续运行；下载器再次运行会核验并跳过成功项。
- 加载停滞：历史仍未完成。排查页面后重新建立采集器重访入口，不修改末尾证据。
- 浏览器帖子失败：修正结构/加载问题后调用 `biliCollector.retryFailed()`，再执行采集。
- 权限、验证码、登录或访问限制：先实际恢复访问。确认恢复后运行 `archive.py --uid UID --output-root ROOT --resume`（专栏范围仍需原参数），再建立采集器；历史进度和文件保持。下载器写出的 `.collection/download-stop.json` 在恢复后由 `download_images.py --root ARCHIVE --failed-only` 清理。恢复许可并不等于一次失败本身被修复，仍要实际测试。
- 下载失败：`download_images.py --root ARCHIVE --failed-only`；图片 URL 失效时先调用 `biliCollector.recapturePost('POST_ID')`，执行 `run(38000, 'capture')` 从查看器重新采集该帖，再补抓。
- 收藏新发布内容：`archive.py --uid UID --output-root ROOT --refresh`，范围参数与原归档一致，再重新遍历全部历史。保留旧图片与成功下载记录。不同范围使用另一个保存根目录。

续传使用临时文件、Range 与 ETag/Last-Modified 校验标识；服务器不支持续传、资源改变或缺少可靠标识时，从头下载该临时文件。限制响应触发停止，普通失败每轮最多四次请求。

## 验证

```bash
python3 scripts/download_images.py --root ARCHIVE
python3 scripts/verify_archive.py --root ARCHIVE
```

有手工保存的已核验样本时，可以追加：

```bash
python3 scripts/verify_archive.py --root ARCHIVE --sample 'POST_ID:1=/ABSOLUTE_SAMPLE_FILE'
```

验证器检查每个文件真实格式、全部帧、尺寸、字节数、哈希、序号、路径、查看器资源对应关系，以及声明的硬链接；样本比较逐字节进行。GIF 单帧仍保存 GIF，MPO 多图容器也保留完整字节。报告区分动图和多图容器。

最终统计包括发现帖子、符合范围帖子、应下载图片、成功图片对应、重复复用、唯一内容及逐项失败。出口状态：全部完成返回 0，未完成返回 1，收到中断信号返回 130。空账号也必须有所有必需入口的明确结束证据。
