"""Validated accounting inputs, also accepted by the legacy change adapter."""
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=48)]
Password = Annotated[str, StringConstraints(min_length=1, max_length=256)]
RecordId = Annotated[int, Field(gt=0, le=2147483647)]
TreeId = Annotated[int, Field(ge=-2147483647, le=2147483647)]
Revision = Annotated[int, Field(ge=0, le=2147483647)]


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Login(Model):
    username: Name
    password: Password


class Profile(Model):
    description: str = Field(default="", max_length=4000)
    user_name: Name
    contacts: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=24)]] = Field(default_factory=list, max_length=20)


class AttachmentRef(Model):
    id: Annotated[str, StringConstraints(pattern=r'^[0-9]+$', max_length=10)]
    # Display metadata is accepted for compatibility, but never trusted or persisted.
    kind: Literal['image', 'voice']
    name: str
    url: str

    @field_validator('id')
    @classmethod
    def valid_id(cls, value):
        if not 0 < int(value) <= 2147483647:
            raise ValueError('Choose a valid attachment.')
        return value


class TransactionInput(Model):
    amount: Decimal = Field(ge=0, le=999999999999.99, max_digits=18, decimal_places=2, allow_inf_nan=False)
    headId: RecordId | None = None
    description: str = Field(default="", max_length=4000)
    transactionTypeId: Literal[1] = 1
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=1000)


class HeadCreate(Model):
    op: Literal['create']
    temp_id: int = Field(ge=-2147483647, lt=0)
    head_name: Name
    parent_head_id: TreeId | None
    head_description: str = Field(default="", max_length=4000)
    is_transactionable: bool = False


class HeadEdit(Model):
    op: Literal['edit']
    head_id: TreeId
    head_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
    head_description: str | None = Field(default=None, max_length=4000)
    image_url: str | None
    is_transactionable: bool


class HeadMove(Model):
    op: Literal['move']
    head_id: TreeId
    new_parent_id: TreeId | None


class HeadMerge(Model):
    op: Literal['merge']
    source_head_id: TreeId
    target_head_id: TreeId
    backup: bool = False


class HeadDelete(Model):
    op: Literal['delete']
    head_id: TreeId


class HeadBackup(Model):
    op: Literal['backup']
    head_id: TreeId


class HeadActive(Model):
    op: Literal['active']
    head_id: TreeId
    is_active: bool


HeadOperation = Annotated[HeadCreate | HeadEdit | HeadMove | HeadMerge | HeadDelete | HeadActive | HeadBackup, Field(discriminator='op')]


class HeadsChange(Model):
    op: Literal['heads']
    revision: Revision
    changes: list[HeadOperation] = Field(max_length=10000)


class PermissionsChange(Model):
    op: Literal['permissions']
    userId: UUID
    ids: list[TreeId] = Field(max_length=10000)


class UserChange(Model):
    op: Literal['user']
    action: Literal['create', 'profile', 'password', 'deactivate', 'reactivate', 'delete', 'pin', 'unpin']
    userId: UUID | None = None
    profile: Profile | None = None
    password: Password | None = None


class CreditUserChange(Model):
    op: Literal['creditUser']
    action: Literal['create', 'edit', 'pin', 'deactivate', 'reactivate', 'delete']
    creditUserId: UUID | None = None
    profile: Profile | None = None
    pinned: bool | None = None


class TransactionChange(Model):
    op: Literal['transaction']
    action: Literal['submit', 'credit', 'edit', 'deactivate', 'reactivate', 'delete']
    userId: UUID | None = None
    creditUserId: UUID | None = None
    contractId: UUID | None = None
    id: RecordId | None = None
    expectedVersion: RecordId | None = None
    input: TransactionInput | None = None



class ContractInput(Model):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
    description: str = Field(default='', max_length=4000)
    totalAmount: Decimal = Field(gt=0, le=999999999999.99, max_digits=18, decimal_places=2, allow_inf_nan=False)
    creditUserIds: list[UUID] = Field(min_length=1, max_length=1000)


class ContractChange(Model):
    op: Literal['contract']
    action: Literal['create', 'edit', 'archive', 'reactivate', 'delete']
    contractId: UUID | None = None
    expectedRevision: Revision | None = None
    input: ContractInput | None = None


class HomeOrderChange(Model):
    op: Literal['homeOrder']
    ids: list[Literal['attachments', 'users', 'company', 'statement', 'heads', 'credit', 'debit', 'receivable', 'payable', 'contracts', 'user-credit']] = Field(min_length=7, max_length=11)


Change = Annotated[HeadsChange | PermissionsChange | UserChange | CreditUserChange | TransactionChange | HomeOrderChange | ContractChange, Field(discriminator='op')]


class AttachmentExport(Model):
    ids: list[RecordId] = Field(min_length=1, max_length=1000)
