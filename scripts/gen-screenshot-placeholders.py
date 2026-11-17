"""生成 README 里 9 张截图的占位图（真实截图放进来直接覆盖同名文件即可）。"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'screenshots')
W, H = 1600, 900

BG = (24, 24, 27)
CARD = (36, 36, 41)
FG = (242, 242, 244)
DIM = (150, 150, 158)
ACCENT = (96, 165, 250)

ITEMS = [
    ('00-hero.png', 'Character Atlas 总览', '详情页「人物」标签 + 满屏卡片墙', '1600×900'),
    ('01-tab.png', '原生标签页', '概览 / 人物 / 记录 / 存档 / 回忆 五标签同排', '横向裁切'),
    ('02-cards.png', '人物卡片墙', '8–12 张角色卡：头像、名字、CV、特质标签', '1600×900'),
    ('03-detail.png', '人物详情弹窗', '左侧立绘 + 头像，右侧资料 / 特质 / 简介 / 外链', '1600×900'),
    ('04-search.png', '跨作品搜索', '点特质（如「双马尾」）后的全部已缓存命中', '1600×900'),
    ('05-context-menu.png', '卡片右键菜单', '「编辑这个人的资料…」/「从本作人物栏删除」', '1340×760'),
    ('06-editor.png', '编辑人物弹窗', '13 个字段：名字、原名、译名、定位、CV、三围…', '1340×760'),
    ('07-migrate.png', '数据搬家', '设置页「人物数据」一行：导出 / 导入 / 清空 / 打开目录', '1600×900'),
    ('08-settings.png', '设置面板', '完整 14 项配置（含「导出时带上图片」）', '1600×1200'),
]


def font(size, bold=False):
    candidates = [
        'C:/Windows/Fonts/msyhbd.ttc' if bold else 'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/segoeuib.ttf' if bold else 'C:/Windows/Fonts/segoeui.ttf',
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def make(name, title, hint, size_hint, index):
    height = 1200 if name.startswith('08') else H
    img = Image.new('RGB', (W, height), BG)
    d = ImageDraw.Draw(img)

    # 顶部窗口条
    d.rectangle([0, 0, W, 56], fill=(30, 30, 34))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([24 + i * 26, 20, 38 + i * 26, 34], fill=c)
    d.text((W - 260, 18), 'Vnite · Character Atlas', font=font(18), fill=DIM)

    # 主卡片
    top = 140
    d.rounded_rectangle([80, top, W - 80, height - 80], radius=18, fill=CARD, outline=(60, 60, 68), width=2)

    d.text((120, top + 46), title, font=font(44, True), fill=FG)
    d.text((120, top + 118), hint, font=font(24), fill=DIM)

    d.rounded_rectangle([120, top + 190, W - 120, top + 196], radius=3, fill=ACCENT)

    lines = [
        '把真实截图放到这个路径并覆盖同名文件：',
        'docs/screenshots/' + name,
        '建议尺寸 ' + size_hint + '，PNG，单张 < 500KB',
        '拍摄要求见 docs/screenshots/README.md',
    ]
    y = top + 250
    for i, line in enumerate(lines):
        d.text((120, y), line, font=font(24 if i else 26, i == 0), fill=FG if i == 0 else DIM)
        y += 46

    # 底部序号
    d.text((W - 200, height - 140), f'{index:02d} / 08', font=font(28, True), fill=(80, 80, 90))
    img.save(os.path.join(OUT, name), optimize=True)
    return name


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for idx, item in enumerate(ITEMS):
        path = make(*item, index=idx)
        print('placeholder:', path)
