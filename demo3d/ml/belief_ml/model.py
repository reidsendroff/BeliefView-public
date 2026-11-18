import torch
from torch import nn
from . import GRID_N, N_CHANNELS, N_SCALARS


class Block(nn.Module):
    def __init__(self, ch, dil, dropout=0.0):
        super().__init__()
        self.conv = nn.Conv2d(ch, ch, 3, padding=dil, dilation=dil, bias=False)
        self.bn = nn.BatchNorm2d(ch)
        self.act = nn.ReLU()
        self.drop = nn.Dropout2d(dropout)

    def forward(self, x):
        return x + self.drop(self.act(self.bn(self.conv(x))))


class BeliefNet(nn.Module):
    """Compact dilated residual CNN: (spatial features, scalar features) -> logits over the GRID_N x GRID_N cells."""
    def __init__(self, ch=32, dilations=(1, 2, 4, 8, 1, 2), s_embed=16, dropout=0.0):
        super().__init__()
        self.scal = nn.Sequential(nn.Linear(N_SCALARS, s_embed), nn.ReLU())
        self.stem = nn.Sequential(nn.Conv2d(N_CHANNELS + s_embed, ch, 3, padding=1, bias=False), nn.BatchNorm2d(ch), nn.ReLU())
        self.blocks = nn.Sequential(*[Block(ch, d, dropout) for d in dilations])
        self.head = nn.Conv2d(ch, 1, 1)

    def forward(self, grid, scalars):
        s = self.scal(scalars)[:, :, None, None].expand(-1, -1, GRID_N, GRID_N)
        x = self.blocks(self.stem(torch.cat([grid, s], 1)))
        return self.head(x).flatten(1)  # logits [B, GRID_N*GRID_N]


class ExportNet(nn.Module):
    """What ships in ONNX: softmax over cells, so the output is a probability grid that sums to 1."""
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, grid, scalars):
        return torch.softmax(self.net(grid, scalars), dim=1)


def describe(ch, dilations, s_embed, dropout=0.0):
    return (f"BeliefNet: scalar MLP({N_SCALARS}->{s_embed}) broadcast + {N_CHANNELS} spatial channels -> 3x3 conv stem({ch}) -> "
            f"{len(dilations)} residual dilated 3x3 conv+BN+ReLU blocks (dilations {list(dilations)}, Dropout2d {dropout} in training only) -> 1x1 conv -> softmax over {GRID_N * GRID_N} cells")
