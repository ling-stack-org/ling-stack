# 启动页动画设计

## 目标

启动动画是首屏过渡层。应用壳体先正常挂载，Canvas 动画覆盖在壳体之上，动画完成后淡出并卸载。这样启动动画不会参与路由、会话或工作区状态，也不会阻塞首屏业务 UI 的初始化。

默认动画复刻现有 HTML 原型的运动关系：风车从画面外吸附到中心，花瓣沿风车叶片聚集后释放散落，风车在整个动画期间持续旋转，最后才减速停止。Canvas 渲染器保留默认风车参考图，参考图加载失败时使用内置矢量风车。

## 非目标

- 主题包不执行 JavaScript、HTML、CSS 或 WASM。
- 主题包不改变启动动画的时长、物理曲线、花瓣轨迹或结束条件。
- 启动动画不承担应用加载进度、错误提示或工作区内容展示。

## 生命周期

1. `App` 挂载 `AppShell` 和 `LaunchTransition`。
2. `LaunchTransition` 立即创建 Canvas 控制器，先使用内置参考图开始播放。
3. 若当前主题声明了启动动画参考图，运行时通过主题仓储异步读取已验证的 Blob。
4. 资源读取成功后，控制器通过 `setReferenceImageUrl` 更新当前风车图，不重置时间轴、不重新播放动画。
5. 资源缺失、主题仓储不可用、Blob URL 创建失败或图片解码失败时继续使用默认风车。
6. 动画完成后进入淡出状态，淡出结束时卸载覆盖层并释放 Blob URL。
7. `prefers-reduced-motion: reduce` 下直接渲染终态并完成过渡，不进入长时间动画循环。

## 主题包契约

主题清单可增加以下字段：

```json
{
  "launchAnimation": {
    "preset": "canvas-windmill",
    "referenceImage": "assets/launch.webp"
  }
}
```

`preset` 目前只有 `canvas-windmill`。`referenceImage` 可选；省略时使用 Ling 内置风车参考图。若存在，路径必须是主题包内 `assets/` 目录下的 PNG 或 WebP 文件，并且不能与 `preview` 指向同一文件。

解析器要求每个包内资源都被清单引用。除 `theme.json`、可选 `LICENSE.txt`、可选 `preview` 和可选 `launchAnimation.referenceImage` 外的文件会被拒绝。资源会在导入时检查文件签名、扩展名、解码结果、尺寸、字节数和 SHA-256；清单校验失败或资源缺失时整个导入失败。

## 资源读取链路

### Web

`parseThemePackageBytes` 产出启动资源的 bytes、Blob、尺寸、MIME 和 checksum。`WebThemePackageRepository` 把资源元数据写入主题包记录，把 Blob 写入 `theme-assets`，并在重导入或删除时按主题清理全部资源。旧的只有 preview 的 IndexedDB 记录仍可读取。

启动层通过 `ThemeProvider.readThemePackage` 请求启动资源。读取失败只影响参考图，不影响首屏过渡或主题本身。

### Desktop

Desktop 安装目录继续由安装记录列出和校验文件。安装记录允许 preview 与 launch 两个资源，并在每次读取时重新检查路径、字节数、checksum、MIME 和图像解码结果。IPC 只增加 `includeLaunchAnimationBytes` 和对应的 ArrayBuffer 字段，保留主窗口主帧校验、请求字段过滤和结构化克隆边界。

Renderer 只获得 descriptor、license 和按请求读取的 bytes，不获得主题包文件系统路径，也不会调用主题包代码。

## 回退与安全边界

默认回退顺序是：主题包已验证的参考图 → 内置 PNG 参考图 → 内置矢量风车。主题清单仍由 Ling 的 Canvas 引擎解释，主题包只能选择已注册 preset 和静态资源。资源 URL 只在当前渲染器内以 Blob URL 存在，组件销毁或主题资源切换时立即释放。

## 验收清单

- token-only、preview-only 和 preview + launch 三种包都能导入。
- 非法 preset、远程 URL、绝对路径、`..` 路径、缺失资源和未引用资源均被拒绝。
- Web 重导入后旧资源被替换，删除后 preview 与 launch 资源都被清理。
- Desktop 安装、读取和重启扫描都能恢复启动资源 descriptor。
- 首屏动画在资源异步到达时不重播，资源失败时仍完成默认动画。
- 风车在最终减速前持续旋转，reduced-motion 路径直接结束。
