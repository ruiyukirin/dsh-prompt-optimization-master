# 截图目录

README 引用的配图。

| 文件 | 内容 | 状态 |
|---|---|---|
| `composer-before.png` | 优化前：草稿 + ✨ 按钮 | ✅ 已就位 |
| `composer-after.png` | 优化后：改写结果 + ↶ 还原按钮 | ✅ 已就位 |
| `settings-page.png` | 设置 → 提示词优化 这一页 | ⏳ 待补 |

## 这两张是怎么来的

由主人提供的原始截图裁剪而成（只保留输入框那一条，去掉聊天内容）：

- 原图：`优化前.png` / `优化后.png`（820×527 / 811×557）
- 裁成：各保留底部 120 像素
- 未裁的原始版本保留在仓库外：`D:\DeepSeek Harness\插件\.wb-research\user-shots\`

裁剪脚本：`D:\DeepSeek Harness\插件\.wb-research\crop-shots.py`

## 规范

- PNG，宽度 800–1200 像素
- **只截输入框区域**，不要带聊天内容
- 深色 / 浅色主题都可以

## 还差 `settings-page.png`

拍法：打开 **设置 → 提示词优化**（左侧栏「插件市场」下面几项的位置）→ `Win + Shift + S`
框选整页 → 存成 `settings-page.png` 放进本目录 → 告诉作者接上引用。

> 之前那张面板截图显示的是 `settings.title` 这类**原始 key**（国际化没接上的 bug）。
> v0.3.0 已修复，并且设置界面从「右键弹层」改成了「设置页」，所以要重新拍。
