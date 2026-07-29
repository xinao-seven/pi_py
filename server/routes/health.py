from fastapi import APIRouter

router = APIRouter(tags=["system"])


@router.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
