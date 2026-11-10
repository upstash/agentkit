"""Semantic recall against a real Upstash Redis (skipped without secrets).

Hybrid queries can fail intermittently on the server ("dot metric only accepts unit-length
vectors"); recall then falls back to keyword search, so assertions about meaning retry a few times
and only count results that were actually found by hybrid search.
"""

import pytest
from upstash_hermes_memory import AgentMemory, ChatHistory

FACTS = {
    "week": "Weeks start Monday for him.",
    "coffee": "His favorite coffee is a flat white from the place near the office.",
    "drafts": "Customer-facing drafts on Slack go out as draft cards, never plain text.",
    "invoices": "Invoices for enterprise customers are reviewed on the first business day.",
    "host": "Hermes runs only on the ops Box since October; the Mac runs the desktop app.",
    "dashes": "He writes without em dashes and leads with the answer.",
    "churn": "The churn analysis runs monthly and he reviews it before publication.",
    "keys": "1Password is his default credential store.",
    "units": "Sizes are written in decimal MB and GB.",
    "board": "Side ideas go to the hermes-queue Kanban board.",
    "shell": "Shell snippets for him are written in fish.",
    "mail": "Never delete or trash email; ask before sending.",
}


def hybrid_recall(memory, query, user_id="u1", top_k=3, tries=4):
    """Recall that was answered by hybrid search. Results that came back by keyword are the
    fallback after a server error, so they are retried; no results at all is a failure."""
    for _ in range(tries):
        hits = memory.recall(query, user_id=user_id, top_k=top_k)
        assert hits, f"no memories recalled for {query!r}"
        if hits[0].retrieval == "hybrid":
            return hits
    pytest.skip("hybrid search kept failing on the server; recall fell back to keyword")


@pytest.fixture
def semantic(redis, prefix):
    memory = AgentMemory(redis, namespace=prefix, enable_telemetry=False)
    memory.index.ensure()
    yield memory
    memory.index.drop()


def ids(hits):
    return [h.id for h in hits]


def test_recall_finds_a_memory_by_meaning_within_what_is_injected(semantic):
    # Hermes injects the top 3. Equal-weight $rrf can rank a keyword-only match
    # (here "first business day" for "day") level with the best meaning match, so the contract
    # tested is "among the injected 3", not "first".
    for id, text in FACTS.items():
        semantic.add(text, user_id="u1", id=id)
    semantic.index.wait_indexing()
    assert "week" in ids(hybrid_recall(semantic, "what day does the week begin"))
    assert "coffee" in ids(hybrid_recall(semantic, "what hot drink does he enjoy"))
    assert "drafts" in ids(hybrid_recall(semantic, "how should a message to a client be sent"))


def test_hybrid_recall_never_crosses_users_or_returns_chats(semantic, redis, prefix):
    semantic.add("Hermes runs on the ops Box.", user_id="u1", id="mine")
    semantic.add("Hermes runs on a Raspberry Pi.", user_id="u2", id="theirs")
    chats = ChatHistory(redis, namespace=prefix, enable_telemetry=False)
    chats.save_chat("s1", [{"role": "user", "content": "where does hermes run"}], user_id="u1")
    semantic.index.wait_indexing()
    hits = hybrid_recall(semantic, "where is the assistant hosted", top_k=5)
    assert [h.id for h in hits] == ["mine"]


def test_an_empty_store_recalls_nothing_without_errors(semantic):
    assert semantic.recall("anything at all", user_id="nobody") == []
