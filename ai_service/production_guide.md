# Future Production Steps

When you are ready to scale the AI service further, implement the following steps.

## 4. Use a Production Server (Gunicorn + Uvicorn)

Running `uvicorn main:app` directly is only suitable for development. For a robust production environment, use **Gunicorn** to manage multiple Uvicorn worker processes. This allows the application to handle concurrent requests efficiently.

**How to implement:**
1.  Install Gunicorn:
    ```bash
    pip install gunicorn
    ```
2.  Run the application using Gunicorn with Uvicorn workers:
    ```bash
    gunicorn -k uvicorn.workers.UvicornWorker main:app --workers 4
    ```
    *Tip: A common rule of thumb for the number of workers is `(2 x $num_cores) + 1`.*

## 5. Add Caching and Rate Limiting

To optimize performance and prevent abuse of the AI service, you need caching and rate limiting.

### Caching
If your model only trains once a day, the 7-day forecast will not change throughout the day. Re-running the neural network for every request wastes CPU/Memory.
**How to implement:**
1.  Use `fastapi-cache2` with a Redis backend.
2.  Add a `@cache(expire=3600)` decorator to your `/forecast` endpoint to cache the response for an hour (or longer).

### Rate Limiting
Prevent users or malicious bots from spamming the endpoint and exhausting server resources.
**How to implement:**
1.  Use `slowapi` (a rate limiter for FastAPI).
2.  Apply decorators like `@limiter.limit("5/minute")` to restrict the number of requests per IP address.
