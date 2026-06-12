#!/usr/bin/env python3
"""Gera versão redigida do diploma removendo dados sensíveis (RG, data nascimento, assinaturas)."""

from PIL import Image, ImageFilter, ImageDraw, ImageFont
import sys
import os

INPUT  = os.path.join(os.path.dirname(__file__), '..', 'certificados', 'diploma-biomedicina.jpg')
OUTPUT = os.path.join(os.path.dirname(__file__), '..', 'certificados', 'diploma-biomedicina-redacted.jpg')

# Regiões sensíveis no diploma (x1, y1, x2, y2) — coordenadas em pixels (2635×1754)
# Linhas "brasileiro, natural do Estado do Paraná" + "nascido a 14 de junho de 1996, RG 129039620/PR"
RG_LINE   = (150,  985, 2500, 1092)
# Assinaturas + nomes/cargos no rodapé (todo o bloco inferior)
SIG_LEFT  = (150,  1290,  900, 1625)
SIG_MID   = (900,  1290, 1700, 1625)
SIG_RIGHT = (1700, 1290, 2500, 1625)

REDACT_REGIONS = [RG_LINE, SIG_LEFT, SIG_MID, SIG_RIGHT]

BLUR_RADIUS = 18   # intensidade do desfoque
FILL_COLOR  = (220, 220, 220)   # cinza claro sobre o borrão


def redact_region(img: Image.Image, box: tuple) -> Image.Image:
    """Aplica desfoque intenso + camada semiopaca em uma região."""
    region = img.crop(box)
    blurred = region.filter(ImageFilter.GaussianBlur(radius=BLUR_RADIUS))
    # segunda passagem para garantir ilegibilidade
    blurred = blurred.filter(ImageFilter.GaussianBlur(radius=BLUR_RADIUS))
    overlay = Image.new('RGB', blurred.size, FILL_COLOR)
    blended = Image.blend(blurred, overlay, alpha=0.55)
    img.paste(blended, box)
    return img


def main():
    print(f"Lendo: {INPUT}")
    img = Image.open(INPUT).convert('RGB')
    print(f"Dimensões: {img.size}")

    for box in REDACT_REGIONS:
        img = redact_region(img, box)
        print(f"  Redigida região: {box}")

    img.save(OUTPUT, 'JPEG', quality=90)
    print(f"Salvo em: {OUTPUT}")


if __name__ == '__main__':
    main()
