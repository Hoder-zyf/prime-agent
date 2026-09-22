# Prime Agent 版本更新手册（fix/update 维护版）

> 这份手册回答：第一次从官方版切换怎么做？以后升级怎么做？失败怎么办？
> **准备新版可以先做；停止旧服务、切换新版，必须等现有任务结束后再做。**

## 先看这三句话

1. 官方 `prime-agent update` 更新的是官方程序，**不会带上本分支的修复**。
2. 本方案改用 `Hoder-zyf/prime-agent` 的 `fix/update` 源码维护版。以后走本手册的更新命令，**不是先执行官方 update 再打补丁**。
3. 更新命令只准备并测试新版；**不会自动停止旧服务，也不会自动切换**。失败时继续用旧版。

已经执行过官方 update 也没关系；不必重装或删除聊天，仍可按下面步骤切换。

## 目录怎么安排

分开保留两个目录，不要在运行中的源码目录里 `git pull`：

| 名称 | 用途 | 可以更新吗？ |
|---|---|---|
| `BASE` | 获取维护分支的源码仓库，不用它启动聊天 | 可以在这里 `git pull --ff-only` |
| `RELEASES` | 每个经过验证的运行版本，各占一个新目录 | 不覆盖旧版本；每次新增一个目录 |
| `CURRENT` | 指向当前运行版本的软链接 | 只在旧服务停止后改指向 |

下文所有命令在**系统终端**执行，不是在聊天里执行。
示例使用 Bash/Zsh。每次新开终端，先重新设置下面这些变量。

```bash
BASE="$HOME/.local/src/prime-agent-maintenance"
RELEASES="$HOME/.local/share/prime-agent-fork/releases"
CURRENT="$HOME/.local/share/prime-agent-fork/current"
TARGET="v0.9.5"
CANDIDATE="$RELEASES/${TARGET}-candidate-1"
```

- `TARGET` 是要合入的官方版本；首次示例是 `v0.9.5`。
- `CANDIDATE` 必须是**尚不存在的新目录**。失败重做时改成 `candidate-2`，不要覆盖旧目录。
- `RELEASES` 应放在长期保留、速度快的本地磁盘上。上面只是默认示例。
  **这次调查的机器 HOME 位于 NFS**，可能触发源码启动超时；请将 `RELEASES` 改为你确认可长期保存的快速本地目录。
  不要把 `/tmp` 中的验证副本当作长期安装，也不要通过增加超时或反复重跑来掩盖失败。
- `CURRENT` 可以仍放在 HOME，指向别处的运行版本。

## A. 第一次切换：以官方 0.9.4 → 维护版 0.9.5 为例

### A1. 检查工具版本

```bash
node --version
npm --version
```

需要当前受支持的 Node.js 22 版本或更新版本，以及 npm ≥11.10。
如果只有旧 npm，可使用下文的单次 `npx` 命令；**不用全局替换系统 npm**。

### A2. 获取维护分支

仅在 `BASE` 尚不存在时执行：

```bash
mkdir -p "$(dirname "$BASE")" "$RELEASES" "$(dirname "$CURRENT")"
git clone --branch fix/update https://github.com/Hoder-zyf/prime-agent.git "$BASE"
```

不要加 `--depth=1`，升级工具需要完整 Git 历史。
如果 `BASE` 已存在，先确认它确实是这个维护仓库；不要删除或覆盖不明目录。
**不需要先在 BASE 执行 `npm ci`**，工具会在候选目录安装依赖。

### A3. 准备并验证新版（此时还没有切换）

```bash
cd "$BASE"
npm run update:cwd-fork -- \
  --upstream-ref "$TARGET" \
  --destination "$CANDIDATE"
```

如果 npm 低于11.10，上面这条命令改用以下命令，**二选一，不要重复执行**：

```bash
cd "$BASE"
npx --yes --package=npm@11.10.0 npm run update:cwd-fork -- \
  --upstream-ref "$TARGET" \
  --destination "$CANDIDATE"
```

工具会获取官方版本、保留维护分支的修复、合并到新目录，再安装依赖并运行检查和测试。
它需要网络，验证会占用一定 CPU/磁盘；不会主动操作现有 daemon 或聊天配置。
只使用可信的源码。测试环境隔离不是文件系统安全沙箱。

**成功标准：命令退出成功，最后出现 `Validated candidate:`，且下面的成功回执存在。**

```bash
cat "$CANDIDATE/.git/cwd-update/receipt.json"
git -C "$CANDIDATE" status --short
```

回执应包含 `"validation": "project"`；Git 状态应为空。
仅仅看到“合并成功”或“依赖安装完成”，不代表验证已经完成。
如果失败，跳到“失败处理”，不要继续 A4。

### A4. 等任务结束，再停止旧服务

**这是第一次会影响正在运行任务的步骤。没有空闲窗口就停在 A3。**

先确认所有会话、子代理、后台命令和定时任务可以停止，再退出旧客户端窗口，避免旧客户端重新拉起旧服务。
首次从官方版切换，在终端执行：

```bash
prime-agent shutdown
```

阅读确认提示。不要默认加 `--force`。
如果旧服务仍忙或无法正常停止，暂停切换，不自动杀进程。
正常停止不会主动删除已保存的聊天，但会结束仍在运行的工作。

### A5. 选择新版，并设置日常入口

先用 `ls -ld "$CURRENT"` 检查：它应当不存在，或者已经是软链接。
如果它是普通目录/文件，先停下来处理，不要直接覆盖。

```bash
ln -sfn "$CANDIDATE" "$CURRENT"
alias primefix="$HOME/.local/share/prime-agent-fork/current/prime-agent.sh"
```

将上面的 **alias 那一行**保存到 `~/.bashrc`（Bash）或 `~/.zshrc`（Zsh）。
如果你改过 `CURRENT` 的位置，alias 也要用对应的绝对路径。
这不会替换系统里原来的 `prime-agent` 程序。

本分支的源码启动器自动指定自身的 `tsconfig.json`，不改变调用者的工作目录；
从其他项目目录启动时，不再依赖那个项目的配置或继承的 `TSX_TSCONFIG_PATH`。
候选验证会从两个独立项目目录（包括带空格的路径）启动实际脚本并检查目录未改变。
这些帮助/导入检查不等于交互聊天或真实会话迁移验收。

### A6. 恢复旧聊天，确认目录

下面的项目路径换成自己的：

```bash
cd /你的项目目录
primefix --resume
```

选择旧聊天后，在**聊天输入框**输入 `!pwd`，确认显示该会话的项目目录，并确认项目 skills 可见。
至少从两个不同项目各恢复一个旧会话验证；不要只看版本号。
使用原有默认的 `~/.prime/agent`，所以通常不必重新登录或复制聊天。
如果以前设置了自定义 agent/session 目录，应保持原来的设置，不能悄悄换成空目录。

以后日常只使用：

```bash
primefix             # 新建会话
primefix --resume    # 选择旧会话
primefix --continue  # 继续当前项目最近的会话
```

不要混用官方 `prime-agent` 和维护版启动聊天，也不要对维护版执行官方 `/update`。

## B. 以后再升级（例如将来升级到一个新官方版本）

1. 重新设置开头的目录变量，把 `TARGET` 改为**已经发布、准备使用**的官方标签，并选一个新的 `CANDIDATE` 路径。
2. 在**不用于运行 daemon 的 BASE** 获取最新维护分支：

   ```bash
   git -C "$BASE" status --short
   git -C "$BASE" pull --ff-only origin fix/update
   ```

   状态必须为空；如有自己的改动或 Git 报冲突，先处理，不用 `reset --hard` 或强制覆盖。
3. 重做 **A3**：准备新目录、跑测试、检查成功回执。旧版本此时继续运行。
4. 记录当前版本的位置：`readlink "$CURRENT"`，保存输出用于回退。
5. 等所有任务结束并关闭旧客户端后，用 **`primefix shutdown`** 正常停止旧维护版。
6. 重做 **A5 的软链接切换**，再按 **A6** 恢复并验收。alias 指向 CURRENT，不必每次重新修改。

**不要在 CURRENT 指向的运行版本中 git pull、合并源码或重新安装依赖。**
升级成功后保留旧版本目录一段时间。
`TARGET` 表示合入的官方标签；维护分支本身可能已经含有更新提交，因此不能把指定旧标签当作降级操作。

## C. 是否还需要 push？

**仅在这台机器使用新版，不必 push。**
若希望把这次验证过的上游合并也保存到维护分支，检查远端是自己的 fork 后再推送：

```bash
git -C "$CANDIDATE" remote get-url --push origin
# 必须确认输出指向 Hoder-zyf/prime-agent，而不是官方仓库。
git -C "$CANDIDATE" config core.hooksPath .husky
git -C "$CANDIDATE" push origin HEAD:refs/heads/fix/update
```

不使用 `--force`。如果提示非快进，重新取得最新维护分支后准备新的候选目录。
分支的 GitHub CI 会验证代码，**不会替你停止服务或部署**。

## D. 失败处理与回退

| 情况 | 应该怎么做 |
|---|---|
| 合并冲突、安装失败、检查或测试失败 | 保留失败候选供检查，继续使用旧版；没有成功回执就不切换 |
| 候选目录已存在 | 换一个新名字，不删除当前版本来腾位置 |
| npm 太旧 | 用 A3 的单次 npm11 命令，或准备独立工具链，不在运行中替换系统环境 |
| NFS/机器负载导致启动超时 | 在快的本地存储准备新候选、排查资源问题；不把超时改大当成修复 |
| 提示后台版本不同，要求停止忙碌会话 | 选 `N`；CLI 和后台必须匹配构建身份，即使都显示0.9.5也可能不同；不要为新开窗口停掉旧工作 |
| 新版已启用，但使用异常 | 等任务安全停下，正常停止新版，把 CURRENT 指回之前记录的旧目录，再启动验收 |

如果仍运行未修复的旧源码版，异目录启动可能报 `pi-agent-core/dist/index.js` 缺失。
不要在运行目录构建依赖或更新代码；仅对**盘点确认与当前后台一致**的旧源码入口临时指定配置：

```bash
LIVE_SOURCE=/当前后台的源码绝对路径
TSX_TSCONFIG_PATH="$LIVE_SOURCE/tsconfig.json" "$LIVE_SOURCE/prime-agent.sh"
```

在目标项目目录执行。不加 `--resume` 是新聊天；仅恢复旧聊天时追加 `--resume`。
这个临时入口不是切换候选版；真正升级仍须 A4 的空闲窗口和明确批准。

回退只切换程序代码，**不保证撤销新版对会话格式做过的迁移**。
若涉及格式兼容问题，先停止操作并检查；不要覆盖或删除 `~/.prime/agent/sessions`。
首次从官方版切换时若没有旧维护版目录，官方可执行文件仍保留；正常停掉维护版后才考虑重新用官方入口。

## 一句话记法

**第一次：取维护源码 → 准备并验证0.9.5 → 等任务结束 → 停旧服务 → 指向新版 → resume验收。**

**以后：取最新维护源码 → 合入新官方版本并验证 → 等任务结束 → 停旧服务 → 切换目录。**

脚本、权限和 CI 的技术细节见 [维护版升级设计](packages/coding-agent/docs/maintained-cwd-upgrades.md)。
