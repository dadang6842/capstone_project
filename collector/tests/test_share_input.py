import unittest
from share_input import extract_share_urls, resolve_share_input, MultipleShareLinksError

A = 'https://chatgpt.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6cf'
B = 'https://chatgpt.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6c0'


class ShareInputTests(unittest.TestCase):
    def test_prose_and_punctuation(self):
        for text in [A, '이 대화 저장해줘 '+A, A+' 이거야', '('+A+')',
                     '['+A+']('+A+')', A+'.', '제목\n'+A+'\n부탁해', A+'; 여깄어']:
            with self.subTest(text=text):
                self.assertEqual(resolve_share_input(text), A)

    def test_duplicate_variants_are_one_link(self):
        self.assertEqual(resolve_share_input(A+' '+A+'/ '+A.upper()), A)

    def test_multiple_distinct_links_require_selection(self):
        with self.assertRaises(MultipleShareLinksError) as caught:
            resolve_share_input(A+'\n'+B)
        self.assertEqual(caught.exception.candidates, [A,B])

    def test_invalid_and_misleading_urls(self):
        for text in ['', '링크 없어', None, A.replace('https:', 'http:'),
                     A.replace('chatgpt.com', 'chatgpt.com.attacker.test'),
                     A.replace('/share/', '/c/'), A+'-extra', A+'/extra', A+'a',
                     A+'?redirect=elsewhere', A+'#section', A.replace('6af3fb20','--------')]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                resolve_share_input(text)

    def test_extract_only_returns_links(self):
        self.assertEqual(extract_share_urls('제목: 내 대화. 저장 요청 '+A), [A])


if __name__ == '__main__':
    unittest.main()
