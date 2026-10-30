"""Public resource shapes for OpenAPI and response filtering."""
from typing import Literal

from pydantic import BaseModel, Field


class UserResource(BaseModel):
    user_id: str
    user_name: str
    description: str
    is_active: bool
    is_pinned: bool
    role: Literal['admin', 'user']
    contacts: list[str]


class ExternalUserResource(BaseModel):
    credit_user_id: str
    user_name: str
    description: str
    contacts: list[str]
    is_active: bool
    is_pinned: bool


class ContractResource(BaseModel):
    id: str
    name: str
    description: str
    totalAmount: float
    isActive: bool
    revision: int
    creditUserIds: list[str]


class AttachmentResource(BaseModel):
    id: str
    kind: Literal['image', 'voice']
    name: str
    url: str


class TransactionValues(BaseModel):
    amount: float
    headId: int | None
    description: str
    transactionTypeId: Literal[1]
    active: bool
    headPath: str
    contractId: str | None
    contractName: str
    attachments: list[AttachmentResource]


class TransactionVersion(TransactionValues):
    versionId: str
    recordedAt: str
    editorId: str
    action: str


class TransactionResource(TransactionValues):
    id: str
    userId: str
    createdBy: str
    createdAt: str
    creditUserId: str | None
    versions: list[TransactionVersion] = Field(default_factory=list)


class TransactionPage(BaseModel):
    items: list[TransactionResource]
    limit: int
    offset: int
    nextOffset: int | None


class SubmissionResource(BaseModel):
    id: str
    applied: bool
