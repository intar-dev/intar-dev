/* The wake stub: a PVH "kernel" for cloud-hypervisor that wakes a Linux guest suspended to RAM (ACPI S3).
 *
 * The VMM starts it in 32-bit protected mode, paging off, flat segments (PVH boot protocol). The stub lives in one
 * page at 1 MiB (the lowest entry address the VMM's ELF loader accepts) that the sleeping kernel was told not to use
 * (memmap=16K$0x100000 on the wake image's command line). It drops to real mode and far-jumps to the kernel's own
 * wake-up vector, real_mode_header->wakeup_start, exactly as firmware does after S3. Linux does the rest.
 *
 * Before the jump:
 *   BARS      bars.inc is a table of (config address for port 0xcf8, value) pairs that travels with the image. Each
 *             value is written with one 32-bit write through 0xcf8/0xcfc, a 64-bit BAR's lower half before its upper
 *             half: cloud-hypervisor moves a 64-bit BAR when the upper half is written and takes the lower half
 *             from the register as it is then. The devices are then where the sleeping kernel expects them, and its
 *             own restore of the config space finds nothing to change.
 *   ACPI_LEN  copies ACPI_LEN bytes from ACPI_SRC (the image's own RSDP and ACPI tables, saved in the reserved pages
 *             behind the stub at build time) back to 0xa0000, over the tables the waking VMM has just written.
 *
 * The kernel build assembles one template per number of BAR writes (intar-kernel-build.sh); the image builder
 * writes the BAR table, the ACPI length and the wake vector of a base into a copy (intar-image-build, wake::stub).
 * HALT=1 builds a variant that only halts (to see what a VMM writes into guest memory at boot).
 */
#ifndef BASE
#define BASE 0x100000
#endif
	.section .text, "ax"
	.code32
	.globl _start
_start:					/* = BASE, the base of the 16-bit code segment below */
	cli
	cld
	movb	$0x29, %al		/* a time stamp in the VMM's log (debug port) */
	outb	%al, $0x80
#ifdef HALT
1:	hlt
	jmp	1b
#else
#ifdef BARS
	movl	$bartab, %esi
1:	lodsl				/* the config address; 0 ends the table */
	testl	%eax, %eax
	jz	2f
	movw	$0xcf8, %dx
	outl	%eax, %dx
	lodsl				/* the register's value */
	movb	$0xfc, %dl
	outl	%eax, %dx
	jmp	1b
2:
#endif
#ifdef ACPI_LEN
	movl	$ACPI_SRC, %esi
	movl	$0xa0000, %edi
	movl	$ACPI_LEN, %ecx
	rep movsb
#endif
	movb	$0x2a, %al		/* a second time stamp: the table is written */
	outb	%al, $0x80
	lgdtl	gdtr
	ljmpl	$0x08, $(pm16 - _start)
	.code16
pm16:					/* 16-bit protected mode: load real-mode sized segments */
	movw	$0x10, %ax
	movw	%ax, %ds
	movw	%ax, %es
	movw	%ax, %ss
	movw	%ax, %fs
	movw	%ax, %gs
	movl	%cr0, %eax
	andl	$0x7ffffffe, %eax	/* clear PG and PE */
	movl	%eax, %cr0
	ljmpw	$WAKE_SEG, $WAKE_OFF	/* real mode from here: the kernel's wakeup_start */

	.balign	8
gdt:	.quad	0
	.word	0xffff, BASE & 0xffff	/* 0x08: 16-bit code, base BASE, limit 64 KiB */
	.byte	(BASE >> 16) & 0xff, 0x9b, 0x00, BASE >> 24
	.word	0xffff, 0x0000		/* 0x10: 16-bit data, base 0, limit 64 KiB */
	.byte	0x00, 0x93, 0x00, 0x00
gdtr:	.word	gdtr - gdt - 1
	.long	gdt
#ifdef BARS
	.balign	4
bartab:
#include "bars.inc"
	.long	0
#endif
#endif

	/* PVH: XEN_ELFNOTE_PHYS32_ENTRY (18) names the 32-bit entry point */
	.section .note.Xen, "a"
	.balign	4
	.long	4, 4, 18
	.asciz	"Xen"
	.long	_start
