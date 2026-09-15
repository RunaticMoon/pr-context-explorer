/* Synthetic ABI for unit-testing helper control flow; NOT Darwin evidence. */
#ifndef PRCE_FAKE_KAUTH_H
#define PRCE_FAKE_KAUTH_H
#include <stdint.h>
#include <stddef.h>
typedef struct { unsigned char bytes[16]; } guid_t;
struct kauth_ace { guid_t ace_applicable; uint32_t ace_flags, ace_rights; };
struct kauth_filesec { uint32_t fsec_magic; guid_t owner, group; uint32_t fsec_entrycount, fsec_flags; struct kauth_ace fsec_ace[1]; };
#define KAUTH_ACE_KINDMASK 15u
#define KAUTH_FILESEC_MAGIC 0x012cc16du
#define KAUTH_FILESEC_SIZE(n) (offsetof(struct kauth_filesec, fsec_ace) + (n)*sizeof(struct kauth_ace))
#endif
