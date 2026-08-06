import re, pathlib

SRC = pathlib.Path(r"E:\AI\WorkBuddy\编程\monkey\Telegram Web Media Downloader Plus 2.0.js")
OUT_DIR = pathlib.Path(r"E:\AI\WorkBuddy\github\telegram-web-media-downloader-plus")
OUT_DIR.mkdir(parents=True, exist_ok=True)

text = SRC.read_text(encoding="utf-8")

# 1) namespace -> coxjjw（明确归属本 fork）
text = re.sub(r'(// @namespace\s+)\S+', r'\1coxjjw', text, count=1)

# 2) 在 @icon 行后插入 @downloadURL / @updateURL，指向本仓库 raw 文件
RAW = "https://raw.githubusercontent.com/coxjjw/telegram-web-media-downloader-plus/main/telegram-web-media-downloader-plus.user.js"
def insert_urls(m):
    return m.group(0) + f"\n// @downloadURL  {RAW}\n// @updateURL    {RAW}"
text = re.sub(r'// @icon\s+\S+', insert_urls, text, count=1)

# 3) 更新“刻意删除 @downloadURL/@updateURL”的注释，说明本 fork 重新启用
old = (" * 注意：上游脚本的 @downloadURL / @updateURL 已被刻意删除，\n"
       " *       否则 Tampermonkey 自动更新会把 ZF 等改动整个覆盖回官方版本。")
new = (" * 注意：原作者的上游脚本曾刻意删除 @downloadURL / @updateURL，\n"
       " *       以免 Tampermonkey 自动更新把 ZF 等改动覆盖回官方版本。\n"
       " *       本仓库（coxjjw 二次修改版）重新启用这两个字段并指向本 GitHub 仓库，\n"
       " *       使 GreasyFork / Tampermonkey 用户能直接获取本 fork 的更新。")
if old in text:
    text = text.replace(old, new, 1)
else:
    print("WARN: 注释未匹配，已跳过")

OUT = OUT_DIR / "telegram-web-media-downloader-plus.user.js"
OUT.write_text(text, encoding="utf-8")
print("written:", OUT, "| bytes:", len(text.encode("utf-8")))

# 简单校验
assert "@downloadURL" in text and "@updateURL" in text, "URL 注入失败"
assert "coxjjw" in text, "namespace 替换失败"
print("校验通过：@downloadURL / @updateURL 已注入，namespace=coxjjw")
