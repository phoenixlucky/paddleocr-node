import unittest

from python.ocr_server import OcrEngine


class FakeResult:
    def __init__(self, payload):
        self.json = {"res": payload}


class PaddleOcr37ResultTests(unittest.TestCase):
    def setUp(self):
        self.engine = OcrEngine.__new__(OcrEngine)

    def test_extracts_nested_37_result(self):
        result = [FakeResult({
            "rec_texts": ["hello", "世界"],
            "rec_scores": [0.98765, 0.87654],
            "rec_polys": [
                [[1, 2], [3, 2], [3, 4], [1, 4]],
                [[5, 6], [7, 6], [7, 8], [5, 8]],
            ],
        })]

        self.assertEqual(self.engine._extract_boxes(result), [
            {"box": [[1, 2], [3, 2], [3, 4], [1, 4]], "text": "hello", "score": 0.9877},
            {"box": [[5, 6], [7, 6], [7, 8], [5, 8]], "text": "世界", "score": 0.8765},
        ])

    def test_uses_rectangular_box_fallback_and_skips_blank_text(self):
        result = [{"res": {
            "rec_texts": ["", "fallback"],
            "rec_scores": [0.1, 0.9],
            "rec_boxes": [[0, 0, 1, 1], [10, 20, 30, 40]],
        }}]

        self.assertEqual(self.engine._extract_boxes(result), [{
            "box": [[10, 20], [30, 20], [30, 40], [10, 40]],
            "text": "fallback",
            "score": 0.9,
        }])

    def test_unlimited_ocr_init_is_lazy(self):
        engine = OcrEngine({"ocrVersion": "Unlimited-OCR"})
        self.assertTrue(engine._is_unlimited_ocr())
        self.assertIsNone(engine._unlimited_model)


if __name__ == "__main__":
    unittest.main()
