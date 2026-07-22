# pi-agent-python

使用 Python、FastAPI 和 Vue 3 学习性复刻 pi coding agent 与 Pi-Agent-Web。

项目采用与 pi 对应的 `pi_ai → pi_agent → pi_coding_agent` 三层包结构。架构说明见
[`docs/three-layer-architecture.md`](docs/three-layer-architecture.md)，完整路线见
[`docs/implementation-plan.md`](docs/implementation-plan.md)。

## 开发检查

```powershell
$env:PYTHONPATH = "src"
python -c "import pi_agent"
python -m pytest
```
