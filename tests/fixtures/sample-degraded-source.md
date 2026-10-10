# 降级互通样例

![正常图片][good]
![远程图片](https://example.test/image.png)
![缺失图片](missing.png)
![不支持格式](sample.svg)
![引用远程][remote]
![缺失引用][undefined]

[good]: sample-image.png
[remote]: https://example.test/reference.png

`![行内代码](missing.png)`

```md
![代码块图片](missing.png)
```
