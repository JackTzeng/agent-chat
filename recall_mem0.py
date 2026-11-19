"""Local decision lookup. stdin contains only the decisions visible to this member."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from urllib.request import urlopen


def download(folder):
    base = ("https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/"
            "resolve/2c4055b12046f11709e9df2c122e59ffbdc2f900/")
    files = {
        "tokenizer.json": "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441",
        "onnx/model_quantized.onnx": "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
    }
    folder.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=folder) as staging:
        for name, digest in files.items():
            tmp = Path(staging) / Path(name).name
            with urlopen(base + name, timeout=90) as src, tmp.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            with tmp.open("rb") as f:
                if hashlib.file_digest(f, "sha256").hexdigest() != digest:
                    raise ValueError(f"Checksum mismatch for {name}")
        for name in files:
            file = Path(name).name
            (Path(staging) / file).replace(folder / file)


def search(folder, request):
    import numpy as np
    import onnxruntime as ort
    from mem0.vector_stores.qdrant import Qdrant
    from qdrant_client import QdrantClient
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(str(folder / "tokenizer.json"))
    tok.enable_truncation(max_length=128)
    tok.enable_padding(pad_id=tok.token_to_id("<pad>"), pad_token="<pad>")
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    model = ort.InferenceSession(str(folder / "model_quantized.onnx"), opts, providers=["CPUExecutionProvider"])

    def embed(texts):
        batch = tok.encode_batch(texts)
        ids = np.asarray([x.ids for x in batch], dtype=np.int64)
        mask = np.asarray([x.attention_mask for x in batch], dtype=np.int64)
        inputs = {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)}
        hidden = model.run(None, {i.name: inputs[i.name] for i in model.get_inputs()})[0]
        return ((hidden * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]).tolist()

    client = QdrantClient(":memory:")
    try:
        store = Qdrant(collection_name="decisions", embedding_model_dims=384, client=client)
        items = request["items"]
        for offset in range(0, len(items), 12):
            batch = items[offset:offset + 12]
            store.insert(embed([it["text"] for it in batch]), ids=[it["id"] for it in batch])
        query = request["query"]
        hits = store.search(query, embed([query])[0], limit=4)
        return [it.id for it in hits if it.score >= 0.34]
    finally:
        client.close()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--download":
        download(Path(sys.argv[2]))
    else:
        os.environ["MEM0_TELEMETRY"] = "false"
        with tempfile.TemporaryDirectory() as scratch:
            os.environ["MEM0_DIR"] = scratch
            print(json.dumps(search(Path(sys.argv[1]), json.load(sys.stdin))))
