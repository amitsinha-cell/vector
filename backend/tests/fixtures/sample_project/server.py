"""FastAPI server application entry point."""
from fastapi import FastAPI

app = FastAPI(title="Sample API")

@app.get("/")
def read_root():
    """Root endpoint returning service status."""
    return {"status": "ok", "service": "sample-backend"}

@app.get("/items/{item_id}")
def read_item(item_id: int):
    """Retrieve item details by identifier."""
    return {"item_id": item_id, "name": f"item-{item_id}"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
