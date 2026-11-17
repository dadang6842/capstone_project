import time


class OpenAIEmbeddingProvider:
    def __init__(self, client):
        self.client = client

    def embed(self, texts, model, *, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= .1:
            raise TimeoutError('Embedding request budget exceeded')
        response = self.client.embeddings.create(
            model=model, input=texts, encoding_format='float', timeout=min(120, remaining)
        )
        usage = response.usage.model_dump() if response.usage else {}
        rows = sorted(response.data, key=lambda row: row.index)
        if [row.index for row in rows] != list(range(len(texts))):
            raise ValueError('Invalid embedding response indices')
        return [list(row.embedding) for row in rows], usage
