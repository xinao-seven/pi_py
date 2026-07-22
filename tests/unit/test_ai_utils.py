from pi_ai.utils import (
    RetryPolicy,
    calculate_context_tokens,
    estimate_context_tokens,
    estimate_message_tokens,
    is_retryable_assistant_error,
)


def test_retry_policy_uses_exponential_backoff_and_classifies_limits() -> None:
    policy = RetryPolicy(max_retries=3, base_delay_seconds=0.25)
    assert [policy.delay_for_attempt(attempt) for attempt in (1, 2, 3)] == [0.25, 0.5, 1.0]
    assert is_retryable_assistant_error(
        {"stopReason": "error", "errorMessage": "503 service unavailable"}
    )
    assert not is_retryable_assistant_error(
        {"stopReason": "error", "errorMessage": "429 insufficient_quota billing limit"}
    )


def test_context_estimate_uses_latest_usage_plus_trailing_messages() -> None:
    messages = [
        {"role": "user", "content": "12345678", "timestamp": 1},
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "answer"}],
            "stopReason": "stop",
            "usage": {"input": 70, "output": 30, "totalTokens": 100},
            "timestamp": 2,
        },
        {
            "role": "toolResult",
            "toolCallId": "call",
            "toolName": "read",
            "content": [{"type": "text", "text": "12345678"}],
            "isError": False,
            "timestamp": 3,
        },
    ]

    estimate = estimate_context_tokens(messages, system_prompt="not counted after usage")

    assert estimate.tokens == 102
    assert estimate.usage_tokens == 100
    assert estimate.trailing_tokens == 2
    assert estimate.last_usage_index == 1
    assert calculate_context_tokens({"input": 10, "output": 5, "cacheRead": 2, "cacheWrite": 1}) == 18


def test_image_estimate_matches_pi_fixed_image_cost() -> None:
    assert estimate_message_tokens(
        {"role": "user", "content": [{"type": "image", "mimeType": "image/png", "data": "tiny"}]}
    ) == 1200
