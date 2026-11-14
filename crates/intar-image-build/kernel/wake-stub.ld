OUTPUT_FORMAT("elf64-x86-64")
ENTRY(_start)
PHDRS
{
  load PT_LOAD FLAGS(5);
  note PT_NOTE FLAGS(4);
}
SECTIONS
{
  . = 0x100000;   /* the stub's one page */
  .text : { *(.text) } :load
  .note : { *(.note.Xen) } :load :note
  /DISCARD/ : { *(.note.gnu*) *(.comment) *(.eh_frame*) *(.data) *(.bss) }
}
