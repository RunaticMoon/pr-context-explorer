/* Test-only synthetic Apple API. Production build never adds this include path. */
#ifndef PRCE_FAKE_ACL_H
#define PRCE_FAKE_ACL_H
#include <sys/types.h>
#include <sys/stat.h>
#include <stdint.h>
#define ACL_MAX_ENTRIES 128
#define _PC_EXTENDED_SECURITY_NP 10000
#define ACL_FIRST_ENTRY 0
#define ACL_NEXT_ENTRY -1
#define ACL_EXTENDED_ALLOW 1
#define ACL_EXTENDED_DENY 2
#define ACL_READ_DATA (1<<1)
#define ACL_WRITE_DATA (1<<2)
#define ACL_EXECUTE (1<<3)
#define ACL_DELETE (1<<4)
#define ACL_APPEND_DATA (1<<5)
#define ACL_DELETE_CHILD (1<<6)
#define ACL_READ_ATTRIBUTES (1<<7)
#define ACL_WRITE_ATTRIBUTES (1<<8)
#define ACL_READ_EXTATTRIBUTES (1<<9)
#define ACL_WRITE_EXTATTRIBUTES (1<<10)
#define ACL_READ_SECURITY (1<<11)
#define ACL_WRITE_SECURITY (1<<12)
#define ACL_CHANGE_OWNER (1<<13)
#define ACL_SYNCHRONIZE (1<<20)
#define ACL_ENTRY_INHERITED (1<<4)
#define ACL_ENTRY_FILE_INHERIT (1<<5)
#define ACL_ENTRY_DIRECTORY_INHERIT (1<<6)
#define ACL_ENTRY_LIMIT_INHERIT (1<<7)
#define ACL_ENTRY_ONLY_INHERIT (1<<8)
#define ACL_FLAG_NO_INHERIT (1<<17)
#define ACL_FLAG_DEFER_INHERIT 1
#define FILESEC_OWNER 1
#define FILESEC_GROUP 2
#define FILESEC_MODE 3
#define FILESEC_ACL 4
typedef int acl_tag_t;
typedef int acl_perm_t;
typedef int acl_flag_t;
typedef uint64_t acl_permset_mask_t;
typedef struct fake_acl *acl_t;
typedef struct fake_entry *acl_entry_t;
typedef uint32_t *acl_flagset_t;
typedef uint32_t *acl_permset_t;
typedef struct fake_filesec *filesec_t;
filesec_t filesec_init(void);
void filesec_free(filesec_t);
int fstatx_np(int, struct stat *, filesec_t);
int filesec_get_property(filesec_t,int,void *);
int filesec_query_property(filesec_t,int,int *);
ssize_t acl_size(acl_t);
ssize_t acl_copy_ext_native(void *,acl_t,ssize_t);
int acl_get_entry(acl_t,int,acl_entry_t *);
int acl_get_tag_type(acl_entry_t,acl_tag_t *);
void *acl_get_qualifier(acl_entry_t);
int acl_get_permset(acl_entry_t,acl_permset_t *);
int acl_get_permset_mask_np(acl_entry_t,acl_permset_mask_t *);
int acl_get_perm_np(acl_permset_t,acl_perm_t);
int acl_get_flagset_np(void *,acl_flagset_t *);
int acl_get_flag_np(acl_flagset_t,acl_flag_t);
int acl_free(void *);
#endif
