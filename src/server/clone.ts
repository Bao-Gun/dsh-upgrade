/**
 * 克隆安装目录用的 cp 候选表：按平台从「首选」排到「兜底」，升级备份与安装脚本共用同一套顺序。
 *
 * - darwin：APFS clonefile（-c）优先，秒级、几乎不占空间；文件系统不支持时 cp 非 0 退出，退回真拷贝。
 * - linux：--reflink=auto 在 btrfs/xfs 上真 CoW，ext4 上由 coreutils 自动退化成整拷贝；
 *   老 coreutils / busybox 认不出 --reflink 时退回普通 -R。GNU cp 没有 -c，所以 Linux 上绝不能先试 -c。
 * - 其它平台：只给普通 -R。
 *
 * 绝不用硬链接（-l）：克隆出来的副本会与线上安装目录共享 inode，试跑写日志/auth 就写进了线上目录。
 * 每条候选都带 -R 与完整 argv（源在前、目标在后）：调用方直接 spawnSync('cp', args)，只负责按顺序试。
 *
 * scripts/install.mjs 是纯 JS、不能 import 这个 TS 模块，那边有一份同样的表；
 * test/clone.test.ts 把两边钉在一起——改这张表必须同批改那边。
 */
export function cloneCandidates(platform: NodeJS.Platform, source: string, dest: string): string[][] {
  if (platform === 'darwin') {
    return [
      ['-c', '-R', source, dest],
      ['-R', source, dest],
    ]
  }
  if (platform === 'linux') {
    return [
      ['--reflink=auto', '-R', source, dest],
      ['-R', source, dest],
    ]
  }
  return [['-R', source, dest]]
}
