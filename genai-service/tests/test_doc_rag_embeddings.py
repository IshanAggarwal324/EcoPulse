"""Tests for the doc-RAG embedding cache + google-genai embedding calls.

No network or real API key: the embedding client is stubbed.

Run:  python -m unittest tests.test_doc_rag_embeddings   (from genai-service/)
"""
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services import doc_rag_service as rag  # noqa: E402


def _chunk(content="body", title="T"):
    return rag.DocChunk(
        doc_id="doc", title=title, content=content, section_index=0, file_path="doc.md"
    )


def _cache(model, dims, contents=("body",)):
    return rag.EmbeddingCache(
        model=model,
        built_at="t",
        chunks=[
            rag.CachedEmbedding(
                doc_id="doc",
                title="T",
                content=c,
                section_index=0,
                file_path="doc.md",
                embedding=[0.1] * dims,
            )
            for c in contents
        ],
    )


class CacheReuseTests(unittest.TestCase):
    def test_reusable_when_model_dims_and_content_match(self):
        self.assertTrue(
            rag._cache_is_reusable(_cache("gemini-embedding-001", 768), [_chunk()], "gemini-embedding-001", 768)
        )

    def test_not_reusable_when_built_with_retired_model(self):
        """A cache from text-embedding-004 must be rebuilt, not trusted: its
        vectors are in a different space and the old model no longer exists."""
        self.assertFalse(
            rag._cache_is_reusable(_cache("text-embedding-004", 768), [_chunk()], "gemini-embedding-001", 768)
        )

    def test_not_reusable_when_dimensions_differ(self):
        self.assertFalse(
            rag._cache_is_reusable(_cache("gemini-embedding-001", 3072), [_chunk()], "gemini-embedding-001", 768)
        )

    def test_not_reusable_when_content_changed(self):
        self.assertFalse(
            rag._cache_is_reusable(_cache("gemini-embedding-001", 768, ("old",)), [_chunk("new")], "gemini-embedding-001", 768)
        )

    def test_not_reusable_when_chunk_count_differs(self):
        self.assertFalse(
            rag._cache_is_reusable(_cache("gemini-embedding-001", 768), [_chunk(), _chunk("two")], "gemini-embedding-001", 768)
        )


class _FakeEmbedModels:
    def __init__(self, count=None):
        self.calls = []
        self._count = count

    def embed_content(self, *, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        n = len(contents) if self._count is None else self._count
        return types.SimpleNamespace(
            embeddings=[types.SimpleNamespace(values=[float(i)] * 4) for i in range(n)]
        )


class EmbedTextsTests(unittest.TestCase):
    def _patched(self, models):
        client = types.SimpleNamespace(models=models)
        return mock.patch.object(rag, "_get_client", return_value=client)

    def test_passes_model_task_type_and_dimensions(self):
        models = _FakeEmbedModels()
        with self._patched(models):
            out = rag._embed_texts(
                ["a", "b"], "gemini-embedding-001", "key",
                task_type="RETRIEVAL_QUERY", dimensions=768, timeout_ms=2500,
            )

        self.assertEqual(len(out), 2)
        call = models.calls[0]
        self.assertEqual(call["model"], "gemini-embedding-001")
        self.assertEqual(str(call["config"].task_type), "RETRIEVAL_QUERY")
        self.assertEqual(call["config"].output_dimensionality, 768)
        self.assertEqual(call["config"].http_options.timeout, 2500)

    def test_count_mismatch_raises(self):
        with self._patched(_FakeEmbedModels(count=1)):
            with self.assertRaises(RuntimeError):
                rag._embed_texts(["a", "b"], "gemini-embedding-001", "key")


class BuildCacheTests(unittest.TestCase):
    def test_stale_model_cache_on_disk_is_rebuilt_and_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cache.json")
            rag._save_cache_to_disk(_cache("text-embedding-004", 768), path)

            models = _FakeEmbedModels()
            client = types.SimpleNamespace(models=models)
            with mock.patch.object(rag, "_get_client", return_value=client):
                result = rag.buildEmbeddingCache(
                    [_chunk()], "key", model="gemini-embedding-001",
                    cache_path=path, dimensions=768,
                )

            self.assertEqual(result.model, "gemini-embedding-001")
            self.assertEqual(len(models.calls), 1, "stale cache must trigger a rebuild")
            self.assertEqual(rag._load_cache_from_disk(path).model, "gemini-embedding-001")


if __name__ == "__main__":
    unittest.main()
