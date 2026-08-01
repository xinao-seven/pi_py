from pi_ai.providers.deepseek import DEEPSEEK_BASE_URL, DeepSeekProvider


def test_deepseek_disables_thinking_explicitly() -> None:
    provider = DeepSeekProvider("secret")

    body = provider.build_request(
        model="deepseek-v4-flash",
        messages=[{"role": "user", "content": "hello"}],
        tools=[],
        thinking_level="off",
        system_prompt="",
    )

    assert provider.base_url == DEEPSEEK_BASE_URL
    assert body["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in body


def test_deepseek_maps_pi_thinking_levels_to_supported_effort() -> None:
    provider = DeepSeekProvider("secret")

    low = provider.build_request(
        model="deepseek-v4-flash",
        messages=[],
        tools=[],
        thinking_level="minimal",
        system_prompt="",
    )
    maximum = provider.build_request(
        model="deepseek-v4-pro",
        messages=[],
        tools=[],
        thinking_level="xhigh",
        system_prompt="",
    )

    assert low["thinking"] == {"type": "enabled"}
    assert low["reasoning_effort"] == "low"
    assert maximum["thinking"] == {"type": "enabled"}
    assert maximum["reasoning_effort"] == "max"
