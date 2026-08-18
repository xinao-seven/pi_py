from fastapi import APIRouter

router = APIRouter(tags=["system"])


@router.get("/api/health")
async def health() -> dict[str, str]:
    """健康检查：返回 {status: ok}。"""
    return {"status": "ok"}
