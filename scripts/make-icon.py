"""把 source 图（方形 App 图标）转成 Windows 打包需要的 PNG 与 ICO。

- build/icon.png   512×512，electron-builder 的默认应用图标
- build/icon.ico   多尺寸（16/24/32/48/64/128/256），任务栏、开始菜单、安装包共用
源图非方形时按短边居中裁剪，避免拉伸变形。
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "build" / "icon-source.jpg"
PNG = ROOT / "build" / "icon.png"
ICO = ROOT / "build" / "icon.ico"

ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]


def square(image: Image.Image) -> Image.Image:
    width, height = image.size
    edge = min(width, height)
    left = (width - edge) // 2
    top = (height - edge) // 2
    return image.crop((left, top, left + edge, top + edge))


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"缺少源图: {SOURCE}")

    image = Image.open(SOURCE).convert("RGBA")
    image = square(image)

    png = image.resize((512, 512), Image.LANCZOS)
    png.save(PNG, "PNG")
    print(f"写出 {PNG.relative_to(ROOT)} ({PNG.stat().st_size} 字节)")

    # ICO 的每一档由 PIL 从这张基准图重采样：先给 256 作为最大档，
    # sizes 列表里的其余尺寸会被逐级缩放写进同一个文件。
    # （不要用 append_images 传多帧，PIL 的 ICO 写入器只认基准图。）
    base = image.resize((256, 256), Image.LANCZOS)
    base.save(ICO, format="ICO", sizes=[(size, size) for size in ICON_SIZES])
    with Image.open(ICO) as written:
        frames = sorted(written.ico.sizes())
    print(f"写出 {ICO.relative_to(ROOT)} ({ICO.stat().st_size} 字节, 档位 {frames})")


if __name__ == "__main__":
    main()
