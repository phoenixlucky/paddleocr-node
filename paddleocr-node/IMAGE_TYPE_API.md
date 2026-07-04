# 快速识图 API 调用说明

快速识图用于判断图片类型：

- `尺寸图`
- `白底图`
- `其他图片`

服务地址：

```text
http://localhost:3100
```

修改代码后需要重启服务，接口才会生效。

## 推荐接口：本机路径识图

适合在同一台电脑上的 Jupyter Notebook、Python 脚本中调用。  
不上传图片文件，只把图片路径发给服务端，速度比文件上传方式更快。

### 请求

```http
POST /api/image-type-path
Content-Type: application/json
```

请求体：

```json
{
  "path": "E:\\基础文件夹\\Downloads\\xxx.jpg"
}
```

### Python / ipynb 示例

```python
import json
import urllib.request

def image_type_local_path(image_path, url="http://localhost:3100/api/image-type-path"):
    body = json.dumps({"path": image_path}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))

result = image_type_local_path(
    r"E:\基础文件夹\Downloads\W504_W504P473678_image+file_20260704\Main Images\MK33063WH CJ (8).jpg"
)
result
```

### 返回示例

```json
{
  "success": true,
  "fileName": "MK33063WH CJ (8).jpg",
  "fileSize": "1.9 MB",
  "category": "白底图",
  "confidence": 0.95
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `success` | 是否调用成功 |
| `fileName` | 图片文件名 |
| `fileSize` | 图片大小 |
| `category` | 识别结果：`尺寸图` / `白底图` / `其他图片` |
| `confidence` | 置信度，范围 `0-1` |

## 备用接口：上传图片识图

适合图片不在服务端本机，或者从其他机器调用。

### 请求

```http
POST /api/image-type
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `file` | file | 图片文件 |

### Python 示例

```python
import json
import mimetypes
import uuid
from pathlib import Path
from urllib import request

def image_type_upload(image_path, url="http://localhost:3100/api/image-type"):
    path = Path(image_path)
    boundary = f"----image-type-{uuid.uuid4().hex}"
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode("utf-8") + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))

result = image_type_upload(r"E:\基础文件夹\Downloads\xxx.jpg")
result
```

## 常见问题

### 浏览器打开 `/api/image-type` 显示说明或 Cannot GET

识图接口需要 `POST` 调用。浏览器地址栏是 `GET`，不能直接识别图片。

### 返回 404

说明当前 `localhost:3100` 还是旧服务。重启服务后再调用。

### 本机路径接口返回“图片路径不存在”

`/api/image-type-path` 读取的是服务端电脑上的路径。  
如果 API 服务和 notebook 不在同一台电脑，请改用上传接口 `/api/image-type`。
