# 插件商店独立设计稿（Prototype）

这是用于确认插件页面信息架构的独立原型，不接生产 API，也不修改生产页面。

```bash
python3 -m http.server 4173 --directory docs/design/prototypes
```

打开 <http://127.0.0.1:4173/plugin-marketplace.html>，右下角可切换“有源 / 加载中 / 无源”状态。也可以直接使用 `?state=empty` 或 `?state=loading`。
