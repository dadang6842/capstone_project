import time
import unittest
from types import SimpleNamespace
from knowledge_relations.provider import OpenAIEmbeddingProvider


class ProviderTests(unittest.TestCase):
    def test_embedding_arguments_and_output_order(self):
        class Client:
            def __init__(self):self.embeddings=self;self.kwargs=None
            def create(self,**kwargs):
                self.kwargs=kwargs
                return SimpleNamespace(data=[SimpleNamespace(index=1,embedding=[0,1]),
                                             SimpleNamespace(index=0,embedding=[1,0])],
                                       usage=SimpleNamespace(model_dump=lambda:{'total_tokens':2}))
        client=Client();provider=OpenAIEmbeddingProvider(client)
        values,usage=provider.embed(['a','b'],'text-embedding-3-small',deadline=time.monotonic()+10)
        self.assertEqual(values,[[1,0],[0,1]])
        self.assertEqual(client.kwargs['encoding_format'],'float')
        self.assertLessEqual(client.kwargs['timeout'],10)
        self.assertEqual(usage['total_tokens'],2)

    def test_expired_budget_does_not_call_client(self):
        provider=OpenAIEmbeddingProvider(None)
        with self.assertRaises(TimeoutError):
            provider.embed(['a'],'model',deadline=time.monotonic()-1)


if __name__=='__main__':unittest.main()
