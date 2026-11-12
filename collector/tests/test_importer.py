import copy
import json
import tempfile
import unittest
from pathlib import Path
from shared_importer import validate_share_url, save_shared_capture, to_source_blocks

URL = 'https://chatgpt.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6cf'


class ImporterContractTests(unittest.TestCase):
    def test_rejects_non_shared_and_untrusted_urls(self):
        for value in [None, 'http://chatgpt.com/share/abc',
                      URL.replace('chatgpt.com', 'chatgpt.com.attacker.test'),
                      URL.replace('/share/', '/c/'),
                      URL.replace('6af3fb20', '--------'), URL+'?redirect=elsewhere']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_share_url(value)
        self.assertEqual(validate_share_url('  '+URL+'  '), URL)

    def test_luna_receives_clean_content_and_source_identity(self):
        record = {'conversation': {'messages': [
            {'source_message_id': 'm1', 'role': 'assistant', 'content': '실제 답변',
             'content_raw': '실제 답변 + 화면 추천 질문', 'code_blocks': []}]}}
        self.assertEqual(to_source_blocks(record), [
            {'source_id': 'm1', 'role': 'assistant', 'text': '실제 답변'}])

    def test_save_roundtrip_dedup_and_content_change(self):
        record = {'source_url': URL, 'captured_at': 'first', 'conversation': {
            'title': '시험', 'messages': [{'role': 'user', 'content': '공백  유지\n다음 줄'}]}}
        with tempfile.TemporaryDirectory() as directory:
            p1, status = save_shared_capture(record, directory)
            self.assertEqual(status, 'saved')
            self.assertEqual(json.loads(p1.read_text())['conversation'], record['conversation'])
            repeat = copy.deepcopy(record)
            repeat['captured_at'] = 'second'
            p2, status = save_shared_capture(repeat, directory)
            self.assertEqual((p2, status), (p1, 'already_saved'))
            changed = copy.deepcopy(record)
            changed['conversation']['messages'][0]['content'] += '\n추가'
            p3, status = save_shared_capture(changed, directory)
            self.assertNotEqual(p1, p3)
            self.assertEqual(status, 'saved')
            self.assertEqual(len(list(Path(directory).glob('*.json'))), 2)


if __name__ == '__main__':
    unittest.main()
