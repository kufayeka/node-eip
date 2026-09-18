'use strict';

// CIP Networks Library Vol 2 (EtherNet/IP Adaptation of CIP) — encapsulation layer.
//
// Port 44818 (0xAF12) is the encapsulation port and is used for BOTH TCP
// (RegisterSession, SendRRData, SendUnitData, ...) and UDP (broadcast
// ListIdentity) — it is not TCP-only despite the common shorthand name.
// Port 2222 (0x08AE) is a separate, UDP-only port used exclusively for
// cyclic Class 0/1 I/O (implicit messaging) data, never for encapsulation
// commands like ListIdentity/RegisterSession.
const EIP_ENCAPSULATION_PORT = 44818;
const EIP_IO_UDP_PORT = 2222;
// Back-compat aliases matching the port's typical transport in this codebase.
const EIP_TCP_PORT = EIP_ENCAPSULATION_PORT;

const ENCAPSULATION_HEADER_LENGTH = 24;

const EncapsulationCommands = Object.freeze({
    NOP: 0x0000,
    ListServices: 0x0004,
    ListIdentity: 0x0063,
    ListInterfaces: 0x0064,
    RegisterSession: 0x0065,
    UnRegisterSession: 0x0066,
    SendRRData: 0x006f,
    SendUnitData: 0x0070,
    IndicateStatus: 0x0072,
    Cancel: 0x0073
});

const EncapsulationStatus = Object.freeze({
    Success: 0x0000,
    InvalidCommand: 0x0001,
    InsufficientMemory: 0x0002,
    IncorrectData: 0x0003,
    InvalidSessionHandle: 0x0064,
    InvalidLength: 0x0065,
    UnsupportedProtocolRevision: 0x0069
});

// CIP Vol 1, Appendix B — general status codes returned in a CIP response.
const CipGeneralStatus = Object.freeze({
    Success: 0x00,
    ConnectionFailure: 0x01,
    ResourceUnavailable: 0x02,
    InvalidParameterValue: 0x03,
    PathSegmentError: 0x04,
    PathDestinationUnknown: 0x05,
    PartialTransfer: 0x06,
    ConnectionLost: 0x07,
    ServiceNotSupported: 0x08,
    InvalidAttributeValue: 0x09,
    AttributeListError: 0x0a,
    AlreadyInRequestedMode: 0x0b,
    ObjectStateConflict: 0x0c,
    ObjectAlreadyExists: 0x0d,
    AttributeNotSettable: 0x0e,
    PrivilegeViolation: 0x0f,
    DeviceStateConflict: 0x10,
    ReplyDataTooLarge: 0x11,
    FragmentationOfPrimitiveValue: 0x12,
    NotEnoughData: 0x13,
    AttributeNotSupported: 0x14,
    TooMuchData: 0x15,
    ObjectDoesNotExist: 0x16,
    ServiceFragmentationSequenceNotInProgress: 0x17,
    NoStoredAttributeData: 0x18,
    StoreOperationFailure: 0x19,
    RoutingFailureRequestPacketTooLarge: 0x1a,
    RoutingFailureResponsePacketTooLarge: 0x1b,
    MissingAttributeListEntryData: 0x1c,
    InvalidAttributeValueList: 0x1d,
    EmbeddedServiceError: 0x1e,
    VendorSpecificError: 0x1f,
    InvalidParameter: 0x20,
    WriteOnceValueOrMediumAlreadyWritten: 0x21,
    InvalidReplyReceived: 0x22,
    BufferOverflow: 0x23,
    MessageFormatError: 0x24,
    KeyFailureInPath: 0x25,
    PathSizeInvalid: 0x26,
    UnexpectedAttributeInList: 0x27,
    InvalidMemberId: 0x28,
    MemberNotSettable: 0x29,
    Group2OnlyServerGeneralFailure: 0x2a,
    UnknownModbusError: 0x2b,
    AttributeNotGettable: 0x2c,
    InstanceNotDeletable: 0x2d,
    ServiceNotSupportedForSpecifiedPath: 0x2e
});

// CIP Vol 1 — common services applicable to most object classes.
const CipCommonServices = Object.freeze({
    GetAttributeAll: 0x01,
    SetAttributeAll: 0x02,
    GetAttributeList: 0x03,
    SetAttributeList: 0x04,
    Reset: 0x05,
    Start: 0x06,
    Stop: 0x07,
    Create: 0x08,
    Delete: 0x09,
    MultipleServicePacket: 0x0a,
    ApplyAttributes: 0x0d,
    GetAttributeSingle: 0x0e,
    SetAttributeSingle: 0x10,
    FindNextObjectInstance: 0x11,
    Restore: 0x15,
    Save: 0x16,
    NoOperation: 0x17,
    GetMember: 0x18,
    SetMember: 0x19,
    InsertMember: 0x1a,
    RemoveMember: 0x1b,
    GroupSync: 0x1c
});

// Rockwell/Logix-specific tag services (not in the base CIP spec, but
// near-universal in practice for Class 3 explicit messaging against Logix5000).
const LogixServices = Object.freeze({
    ReadTag: 0x4c,
    WriteTag: 0x4d,
    ReadModifyWriteTag: 0x4e,
    ReadTagFragmented: 0x52,
    WriteTagFragmented: 0x53
});

const DeltaServices = Object.freeze({
    ReadParameter: 0x32,
    WriteParameter: 0x33
});

// CIP Vol 1 — well-known class codes referenced by the encapsulation/session
// and connection-manager layers.
const CipClassCodes = Object.freeze({
    Identity: 0x01,
    MessageRouter: 0x02,
    Assembly: 0x04,
    ConnectionManager: 0x06,
    Parameter: 0x0f,
    DLR: 0x47,
    QoS: 0x48,
    Port: 0xf4,
    TcpIpInterface: 0xf5,
    EthernetLink: 0xf6
});

module.exports = {
    EIP_ENCAPSULATION_PORT,
    EIP_IO_UDP_PORT,
    EIP_TCP_PORT,
    ENCAPSULATION_HEADER_LENGTH,
    EncapsulationCommands,
    EncapsulationStatus,
    CipGeneralStatus,
    CipCommonServices,
    LogixServices,
    DeltaServices,
    CipClassCodes
};
