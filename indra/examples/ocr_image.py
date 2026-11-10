"""Extract text from one image file with Indra OCR.

    python examples/ocr_image.py scan.png                 # markdown
    python examples/ocr_image.py photo.jpg --format text  # plain text, one line per line
    python examples/ocr_image.py form.tiff --format json  # lines with boxes and confidence

Images (PNG, JPEG, TIFF, BMP, WebP) and PDFs both work: the file's bytes decide
how it is read. A multi-page TIFF gives one result per frame. The first run
downloads the models from Hugging Face.
"""

import argparse
import json

import indra_ocr


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("image", help="path to an image (or PDF) file")
    ap.add_argument(
        "--format", choices=["markdown", "text", "json"], default="markdown"
    )
    ap.add_argument("--math", action="store_true", help="write math as LaTeX")
    a = ap.parse_args()

    conv = indra_ocr.load(threads=4, math=a.math)
    for i, page in conv.convert(a.image):
        if a.format == "markdown":
            print(page.markdown if page.markdown is not None else page.text)
        elif a.format == "text":
            print(page.text)
        else:
            print(
                json.dumps(
                    {
                        "page": i,
                        "rotation": page.rotation,  # quarter turn undone, degrees
                        "skew": page.skew,  # small tilt straightened, degrees
                        "lines": [
                            {"box": ln.box, "text": ln.text, "conf": ln.conf}
                            for ln in page.lines  # reading order, boxes in image pixels
                        ],
                        "blocks": page.blocks,  # layout blocks: label, bbox, text
                    },
                    ensure_ascii=False,
                )
            )


def ocr_array_example():
    """An image already in memory (a camera frame, a crop, a decoded upload):
    pass a grayscale uint8 numpy array to ``conv.ocr``."""
    import cv2  # installed with indra-ocr

    conv = indra_ocr.load(threads=4)
    color = cv2.imread("scan.png")  # any BGR / RGB uint8 array works the same way
    gray = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
    page = conv.ocr(gray)
    print(page.text)


if __name__ == "__main__":
    main()
