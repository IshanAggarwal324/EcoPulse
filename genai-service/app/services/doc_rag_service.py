from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class DocChunk:
    doc_id: str
    title: str
    content: str
    section_index: int
    file_path: str
    char_count: int = 0

    def __post_init__(self):
        if self.char_count == 0:
            self.char_count = len(self.content)


@dataclass
class CachedEmbedding:
    doc_id: str
    title: str
    content: str
    section_index: int
    file_path: str
    embedding: list[float]


@dataclass
class EmbeddingCache:
    chunks: list[CachedEmbedding] = field(default_factory=list)
    model: str = ""
    built_at: str = ""


def _split_by_h2(markdown: str) -> list[tuple[str, str]]:
    pattern = re.compile(r"^##\s+(.+)$", re.MULTILINE)
    matches = list(pattern.finditer(markdown))

    if not matches:
        stripped = markdown.strip()
        if stripped:
            return [("", stripped)]
        return []

    chunks: list[tuple[str, str]] = []

    before = markdown[: matches[0].start()].strip()
    if before:
        chunks.append(("", before))

    for i, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        content = markdown[start:end].strip()
        if content:
            chunks.append((title, content))

    return chunks


def loadDocChunks(docs_dir: str | Path) -> list[DocChunk]:
    docs_path = Path(docs_dir)

    if not docs_path.is_dir():
        logger.warning("Docs directory does not exist: %s", docs_path)
        return []

    all_chunks: list[DocChunk] = []

    md_files = sorted(docs_path.glob("*.md"))

    if not md_files:
        logger.warning("No .md files found in %s", docs_path)
        return []

    for md_file in md_files:
        doc_id = md_file.stem
        try:
            raw = md_file.read_text(encoding="utf-8")
        except OSError:
            logger.exception("Failed to read doc file: %s", md_file)
            continue

        sections = _split_by_h2(raw)

        if not sections:
            logger.debug("Skipping empty doc: %s", doc_id)
            continue

        for idx, (title, content) in enumerate(sections):
            section_title = title if title else doc_id.replace("-", " ").title()
            all_chunks.append(
                DocChunk(
                    doc_id=doc_id,
                    title=section_title,
                    content=content,
                    section_index=idx,
                    file_path=str(md_file),
                )
            )

    logger.info(
        "Loaded %d chunks from %d docs in %s",
        len(all_chunks),
        len(md_files),
        docs_path,
    )
    return all_chunks


def _cache_to_dict(cache: EmbeddingCache) -> dict:
    return {
        "model": cache.model,
        "built_at": cache.built_at,
        "chunks": [
            {
                "doc_id": c.doc_id,
                "title": c.title,
                "content": c.content,
                "section_index": c.section_index,
                "file_path": c.file_path,
                "embedding": c.embedding,
            }
            for c in cache.chunks
        ],
    }


def _dict_to_cache(data: dict) -> EmbeddingCache:
    chunks = [
        CachedEmbedding(
            doc_id=c["doc_id"],
            title=c["title"],
            content=c["content"],
            section_index=c["section_index"],
            file_path=c["file_path"],
            embedding=c["embedding"],
        )
        for c in data.get("chunks", [])
    ]
    return EmbeddingCache(
        chunks=chunks,
        model=data.get("model", ""),
        built_at=data.get("built_at", ""),
    )


def _load_cache_from_disk(cache_path: str) -> Optional[EmbeddingCache]:
    path = Path(cache_path)
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
        return _dict_to_cache(json.loads(raw))
    except (OSError, json.JSONDecodeError, KeyError):
        logger.exception("Failed to load embedding cache from %s", cache_path)
        return None


def _save_cache_to_disk(cache: EmbeddingCache, cache_path: str) -> None:
    path = Path(cache_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.write_text(json.dumps(_cache_to_dict(cache)), encoding="utf-8")
        logger.info("Saved embedding cache to %s (%d chunks)", cache_path, len(cache.chunks))
    except OSError:
        logger.exception("Failed to save embedding cache to %s", cache_path)


def _embed_texts(texts: list[str], model: str) -> list[list[float]]:
    import google.generativeai as genai

    task_type = "retrieval_document"
    result = genai.embed_content(
        model=f"models/{model}",
        content=texts,
        task_type=task_type,
    )
    return result["embedding"]


def buildEmbeddingCache(
    chunks: list[DocChunk],
    gemini_api_key: str,
    model: str = "text-embedding-004",
    cache_path: str = "",
) -> EmbeddingCache:
    if cache_path:
        disk_cache = _load_cache_from_disk(cache_path)
        if disk_cache is not None and len(disk_cache.chunks) == len(chunks):
            content_match = all(
                dc.content == c.content
                for dc, c in zip(disk_cache.chunks, chunks)
            )
            if content_match:
                logger.info(
                    "Embedding cache hit: %d chunks from %s", len(chunks), cache_path
                )
                return disk_cache
            logger.info("Embedding cache stale (content changed), rebuilding")
        elif disk_cache is not None:
            logger.info(
                "Embedding cache stale (%d cached vs %d current), rebuilding",
                len(disk_cache.chunks),
                len(chunks),
            )

    if not gemini_api_key:
        logger.warning("GEMINI_API_KEY not set — embedding cache will be empty")
        return EmbeddingCache(model=model)

    import google.generativeai as genai
    from datetime import datetime, timezone

    genai.configure(api_key=gemini_api_key)

    batch_size = 100
    all_embeddings: list[list[float]] = []

    for i in range(0, len(chunks), batch_size):
        batch = chunks[i : i + batch_size]
        texts = [f"{c.title}\n\n{c.content}" for c in batch]
        logger.info(
            "Embedding batch %d/%d (%d texts)",
            i // batch_size + 1,
            -(-len(chunks) // batch_size),
            len(batch),
        )
        batch_embeddings = _embed_texts(texts, model)
        all_embeddings.extend(batch_embeddings)

    cached_chunks = [
        CachedEmbedding(
            doc_id=c.doc_id,
            title=c.title,
            content=c.content,
            section_index=c.section_index,
            file_path=c.file_path,
            embedding=emb,
        )
        for c, emb in zip(chunks, all_embeddings)
    ]

    cache = EmbeddingCache(
        chunks=cached_chunks,
        model=model,
        built_at=datetime.now(timezone.utc).isoformat(),
    )

    if cache_path:
        _save_cache_to_disk(cache, cache_path)

    logger.info("Built embedding cache: %d chunks, model=%s", len(cached_chunks), model)
    return cache


@dataclass
class SearchResult:
    doc_id: str
    title: str
    excerpt: str
    score: float
    section_index: int


def cosineSimilarity(a: list[float] | np.ndarray, b: list[float] | np.ndarray) -> float:
    vec_a = np.asarray(a, dtype=np.float64)
    vec_b = np.asarray(b, dtype=np.float64)
    norm_a = np.linalg.norm(vec_a)
    norm_b = np.linalg.norm(vec_b)
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return float(np.dot(vec_a, vec_b) / (norm_a * norm_b))


def searchChunks(
    query_embedding: list[float],
    cache: EmbeddingCache,
    top_k: int = 3,
) -> list[SearchResult]:
    if not cache.chunks:
        return []

    scored: list[tuple[float, CachedEmbedding]] = []
    for cached in cache.chunks:
        if not cached.embedding:
            continue
        score = cosineSimilarity(query_embedding, cached.embedding)
        scored.append((score, cached))

    scored.sort(key=lambda pair: pair[0], reverse=True)

    top = scored[:top_k]
    return [
        SearchResult(
            doc_id=c.doc_id,
            title=c.title,
            excerpt=c.content[:500],
            score=round(s, 4),
            section_index=c.section_index,
        )
        for s, c in top
    ]


class DocRagService:
    def __init__(self, settings):
        self._settings = settings
        self._cache = EmbeddingCache(model=settings.embedding_model)
        self._initialized = False

    def initialize(self, docs_dir: str | None = None) -> None:
        if self._initialized:
            return

        dir_path = docs_dir or self._settings.docs_dir
        if not dir_path:
            logger.info("No DOCS_DIR configured — doc RAG disabled")
            self._initialized = True
            return

        chunks = loadDocChunks(dir_path)
        if not chunks:
            self._initialized = True
            return

        self._cache = buildEmbeddingCache(
            chunks=chunks,
            gemini_api_key=self._settings.gemini_api_key,
            model=self._settings.embedding_model,
            cache_path=self._settings.embedding_cache_path,
        )
        self._initialized = True

    @property
    def is_available(self) -> bool:
        return bool(self._cache.chunks)

    def retrieveDocChunks(self, query: str, top_k: int = 3) -> list[dict]:
        if not self.is_available:
            return []

        query_embedding = self._embed_query(query)
        if not query_embedding:
            return []

        results = searchChunks(query_embedding, self._cache, top_k=top_k)
        return [
            {
                "docId": r.doc_id,
                "title": r.title,
                "excerpt": r.excerpt,
                "score": r.score,
                "sectionIndex": r.section_index,
            }
            for r in results
        ]

    def _embed_query(self, text: str) -> list[float]:
        if not self._settings.gemini_api_key:
            return []
        try:
            embeddings = _embed_texts([text], self._cache.model)
            return embeddings[0]
        except Exception:
            logger.exception("Failed to embed query: %s", text[:80])
            return []
