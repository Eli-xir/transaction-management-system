"""Resource-specific request bodies. Resource identity belongs in the URL."""
from uuid import UUID

from pydantic import Field

from models import Model, Profile, Password, TransactionInput, HeadOperation, HomeOrderChange, RecordId, Revision, TreeId



class CreateUser(Model):
    profile: Profile
    password: Password


class SetPassword(Model):
    password: Password


class SetActive(Model):
    active: bool


class SetPinned(Model):
    pinned: bool


class Permissions(Model):
    ids: list[TreeId] = Field(max_length=10000)


class CreateTransaction(Model):
    input: TransactionInput


class CreateCredit(CreateTransaction):
    userId: UUID
    creditUserId: UUID | None = None
    contractId: UUID | None = None


class EditTransaction(CreateTransaction):
    expectedVersion: RecordId
    contractId: UUID | None = None


class TransactionStatus(Model):
    active: bool
    expectedVersion: RecordId


class ContractRevision(Model):
    expectedRevision: Revision


class ContractStatus(ContractRevision):
    active: bool


class HeadBatch(Model):
    revision: Revision
    changes: list[HeadOperation] = Field(max_length=10000)


class HomeOrder(Model):
    ids: HomeOrderChange.model_fields['ids'].annotation = Field(min_length=7, max_length=11)
