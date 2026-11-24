# 设计原型

## 插件商店

这是用于确认插件页面信息架构的独立原型，不接生产 API，也不修改生产页面。

```bash
python3 -m http.server 4173 --directory docs/design/prototypes
```

打开 <http://127.0.0.1:4173/plugin-marketplace.html>，右下角可切换“有源 / 加载中 / 无源”状态。也可以直接使用 `?state=empty` 或 `?state=loading`。

## 设置页概念图

[工作树、设备存储、浏览器设置](settings-storage-browser/README.md)是三张静态布局稿。
其中目录、容量、网站和工作树条目都是示例数据，不是产品运行证据。
