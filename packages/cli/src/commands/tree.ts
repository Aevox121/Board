/**
 * `board tree <路径>` — 以文件树打印 `files/`。
 *
 * 规格 §2.4：以文件树打印 files/。
 */
import { listBoardFiles } from '@board/core/node';
import type { ParsedArgs } from '../util/args';
import { EXIT, type CmdResult } from '../util/io';
import { resolveBoardDir } from '../util/board';

/** 文件树的一个节点（目录或文件）。 */
interface TreeNode {
  name: string;
  /** 子节点（目录才有；文件为空 Map） */
  children: Map<string, TreeNode>;
  isFile: boolean;
}

/** 新建一个空节点。 */
function newNode(name: string, isFile: boolean): TreeNode {
  return { name, children: new Map(), isFile };
}

/** 把扁平的相对路径列表组装成树。 */
function buildTree(paths: string[]): TreeNode {
  const root = newNode('files/', false);
  for (const p of paths) {
    const segs = p.split('/');
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg === undefined || seg === '') continue;
      const isFile = i === segs.length - 1;
      let child = cur.children.get(seg);
      if (child === undefined) {
        child = newNode(seg, isFile);
        cur.children.set(seg, child);
      }
      cur = child;
    }
  }
  return root;
}

/** 把树渲染成带缩进连线的字符串行。 */
function renderTree(node: TreeNode): string[] {
  const lines: string[] = [node.name];

  function walk(n: TreeNode, prefix: string): void {
    // 目录在前、文件在后，各自按名称排序
    const kids = [...n.children.values()].sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    kids.forEach((kid, idx) => {
      const last = idx === kids.length - 1;
      const branch = last ? '└── ' : '├── ';
      const suffix = kid.isFile ? '' : '/';
      lines.push(`${prefix}${branch}${kid.name}${suffix}`);
      walk(kid, prefix + (last ? '    ' : '│   '));
    });
  }

  walk(node, '');
  return lines;
}

/**
 * 执行 tree 命令。
 *
 * @param args 位置参数[0] = 白板路径
 */
export async function cmdTree(args: ParsedArgs): Promise<CmdResult> {
  const dir = resolveBoardDir(args.positionals[0], args.options.get('board'));
  const files = await listBoardFiles(dir);
  const tree = buildTree(files);

  const text =
    files.length === 0
      ? 'files/\n（空）'
      : renderTree(tree).join('\n');

  return { code: EXIT.OK, text, data: { files } };
}
