FROM python:3.12-slim
WORKDIR /app
COPY server.py ./
COPY static ./static
ENV TOKENOMICS_CONFIG=/app/config.json TOKENOMICS_STATE=/app/state/state.json TOKENOMICS_PORT=8787 TOKENOMICS_QUIET=1
# state lives in /app/state so it can be a named volume; config is bind-mounted
RUN mkdir -p /app/state
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD python3 -c "import os,sys,urllib.request as u; p=os.environ.get('TOKENOMICS_PORT','8787'); sys.exit(0 if u.urlopen('http://127.0.0.1:%s/healthz' % p).status==200 else 1)"
CMD ["python3", "server.py"]
