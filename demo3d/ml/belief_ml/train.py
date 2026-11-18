import os, random, time
import numpy as np
import torch
from torch import nn
from . import GRID_N
from .model import BeliefNet


def seed_everything(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    torch.use_deterministic_algorithms(True, warn_only=True)
    torch.backends.cudnn.benchmark = False


def to_tensors(d, device):
    return (torch.from_numpy(d["codes"]).to(device), torch.from_numpy(d["scalars"]).to(device), torch.from_numpy(d["target"]).to(device))


def predict(net, d, device, bs=512):
    net.eval()
    outs = []
    with torch.no_grad():
        for a in range(0, len(d["codes"]), bs):
            g = torch.from_numpy(d["codes"][a:a + bs]).to(device).float() / 255.0
            s = torch.from_numpy(d["scalars"][a:a + bs]).to(device)
            outs.append(torch.softmax(net(g, s), 1).float().cpu().numpy())
    return np.concatenate(outs) if outs else np.zeros((0, GRID_N * GRID_N), np.float32)


def fit(train, val, cfg, device, log=print):
    """Cross-entropy on the true cell. Early-stops on validation NLL (inside-grid samples only)."""
    net = BeliefNet(cfg["channels"], tuple(cfg["dilations"]), cfg["scalar_embed"], cfg["dropout"]).to(device)
    n_params = sum(p.numel() for p in net.parameters())
    opt = torch.optim.AdamW(net.parameters(), lr=cfg["lr"], weight_decay=cfg["weight_decay"])
    keep = np.where(train["inside"])[0]
    steps = cfg["epochs"] * int(np.ceil(len(keep) / cfg["batch"]))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=cfg["lr"], total_steps=steps, pct_start=0.15)
    gtr = torch.from_numpy(train["codes"]).to(device)
    str_ = torch.from_numpy(train["scalars"]).to(device)
    ttr = torch.from_numpy(train["target"]).to(device)
    gen = torch.Generator().manual_seed(cfg["seed"])
    ce = nn.CrossEntropyLoss()
    vin = np.where(val["inside"])[0]
    best, best_state, hist, bad = 1e9, None, [], 0
    t0 = time.time()
    for ep in range(cfg["epochs"]):
        net.train()
        perm = keep[torch.randperm(len(keep), generator=gen).numpy()]
        tot = 0.0
        for a in range(0, len(perm), cfg["batch"]):
            idx = torch.from_numpy(perm[a:a + cfg["batch"]]).to(device)
            loss = ce(net(gtr[idx].float() / 255.0, str_[idx]), ttr[idx])
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            tot += loss.item() * len(idx)
        vp = predict(net, val, device)
        vnll = float(-np.log(np.maximum(vp[vin, val["target"][vin]], 1e-9)).mean())
        hist.append({"epoch": ep + 1, "train_nll": tot / len(keep), "val_nll": vnll})
        log(f"epoch {ep + 1:3d}/{cfg['epochs']}  train_nll {tot / len(keep):.4f}  val_nll {vnll:.4f}  ({time.time() - t0:.0f}s)")
        if vnll < best - 1e-4:
            best, bad = vnll, 0
            best_state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
            hist[-1]["best"] = True
        else:
            bad += 1
            if bad >= cfg["patience"]:
                log(f"early stop: no val improvement for {bad} epochs")
                break
    net.load_state_dict(best_state)
    return net, n_params, hist
